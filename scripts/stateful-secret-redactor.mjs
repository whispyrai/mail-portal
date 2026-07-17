const REDACTION = "[REDACTED]";
const SUPPRESSION =
	"[OUTPUT SUPPRESSED: a configured secret exceeds the redaction buffer]";
const BEARER_PREFIX = "bearer";
const TOKEN_DELIMITER = /[\s"']/;

export class StatefulSecretRedactor {
	constructor(secrets, { maxCarry = 64 * 1024 } = {}) {
		if (!Number.isSafeInteger(maxCarry) || maxCarry < 32) {
			throw new Error("maxCarry must be an integer of at least 32 characters");
		}
		this.maxCarry = maxCarry;
		this.secrets = [
			...new Set(
				secrets
					.filter((secret) => typeof secret === "string" && secret.length > 0)
					.map(String),
			),
		].sort((left, right) => right.length - left.length);
		this.buffer = "";
		this.discardingBearerToken = false;
		this.suppressAll = this.secrets.some(
			(secret) => secret.length > this.maxCarry,
		);
		this.reportedSuppression = false;
	}

	write(value) {
		if (this.suppressAll) {
			if (this.reportedSuppression) return "";
			this.reportedSuppression = true;
			return SUPPRESSION;
		}
		this.buffer += String(value);
		return this.#drain(false);
	}

	flush() {
		if (this.suppressAll) {
			if (this.reportedSuppression) return "";
			this.reportedSuppression = true;
			return SUPPRESSION;
		}
		return this.#drain(true);
	}

	#drain(final) {
		let safe = "";
		while (this.buffer.length > 0) {
			if (this.discardingBearerToken) {
				const delimiterIndex = this.buffer.search(TOKEN_DELIMITER);
				if (delimiterIndex === -1) {
					this.buffer = "";
					if (final) this.discardingBearerToken = false;
					break;
				}
				this.buffer = this.buffer.slice(delimiterIndex);
				this.discardingBearerToken = false;
				continue;
			}

			const completeSecret = this.secrets.find((secret) =>
				this.buffer.startsWith(secret),
			);
			if (completeSecret) {
				safe += REDACTION;
				this.buffer = this.buffer.slice(completeSecret.length);
				continue;
			}
			if (
				!final &&
				this.secrets.some((secret) => secret.startsWith(this.buffer))
			) {
				break;
			}

			const lowerBuffer = this.buffer.toLowerCase();
			if (
				!final &&
				this.buffer.length < BEARER_PREFIX.length &&
				BEARER_PREFIX.startsWith(lowerBuffer)
			) {
				break;
			}
			if (lowerBuffer.startsWith(BEARER_PREFIX)) {
				if (this.buffer.length === BEARER_PREFIX.length) {
					if (!final) break;
					safe += this.buffer;
					this.buffer = "";
					continue;
				}
				if (!/\s/.test(this.buffer[BEARER_PREFIX.length])) {
					safe += this.buffer[0];
					this.buffer = this.buffer.slice(1);
					continue;
				}

				let tokenStart = BEARER_PREFIX.length;
				while (
					tokenStart < this.buffer.length &&
					/\s/.test(this.buffer[tokenStart])
				) {
					tokenStart += 1;
				}
				if (tokenStart === this.buffer.length) {
					if (!final) break;
					safe += this.buffer;
					this.buffer = "";
					continue;
				}

				const tokenEndOffset = this.buffer
					.slice(tokenStart)
					.search(TOKEN_DELIMITER);
				if (tokenEndOffset >= 0) {
					safe += `Bearer ${REDACTION}`;
					this.buffer = this.buffer.slice(tokenStart + tokenEndOffset);
					continue;
				}
				if (final) {
					safe += `Bearer ${REDACTION}`;
					this.buffer = "";
					continue;
				}
				if (this.buffer.length > this.maxCarry) {
					safe += `Bearer ${REDACTION}`;
					this.buffer = "";
					this.discardingBearerToken = true;
				}
				break;
			}

			safe += this.buffer[0];
			this.buffer = this.buffer.slice(1);
		}
		return safe;
	}
}

export function redactCompleteValue(value, secrets) {
	const redactor = new StatefulSecretRedactor(secrets);
	return redactor.write(value) + redactor.flush();
}
