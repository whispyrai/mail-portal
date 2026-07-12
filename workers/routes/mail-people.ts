import { Hono, type Context } from "hono";
import {
	MailPeopleContractError,
	normalizeMailPeopleListQuery,
	normalizeMailPersonTimelineQuery,
	validateMailPersonId,
	validateMailPeopleListResponse,
	validateMailPersonDetailResponse,
	validateMailPersonTimelineResponse,
	type MailPeopleListResponse,
	type MailPersonDetailResponse,
	type MailPersonTimelineResponse,
	type NormalizedMailPeopleListQuery,
	type NormalizedMailPersonTimelineQuery,
} from "../../shared/mail-people.ts";
import {
	hasLiveMailboxContentAccess,
	type MailboxContext,
} from "../lib/mailbox.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";

type AppContext = Context<MailboxContext>;

export type MailPeopleOperations = {
	list(mailboxAddress: string, query: NormalizedMailPeopleListQuery): Promise<MailPeopleListResponse>;
	detail(mailboxAddress: string, personId: string): Promise<MailPersonDetailResponse>;
	timeline(
		mailboxAddress: string,
		personId: string,
		query: NormalizedMailPersonTimelineQuery,
	): Promise<MailPersonTimelineResponse>;
};

export type MailPeopleRouteDependencies = {
	operations(c: AppContext): MailPeopleOperations;
	revalidateAccess(c: AppContext): Promise<boolean>;
};

function mailboxAddress(raw: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		throw new MailPeopleContractError("Mailbox address is invalid");
	}
	const address = normalizeMailAddress(decoded);
	if (!address) throw new MailPeopleContractError("Mailbox address is invalid");
	return address;
}

function personId(raw: string): string {
	let value: string;
	try {
		value = decodeURIComponent(raw);
	} catch {
		throw new MailPeopleContractError("Person id is invalid");
	}
	return validateMailPersonId(value);
}

export function createMailPeopleRoutes(dependencies: MailPeopleRouteDependencies) {
	const routes = new Hono<MailboxContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/people", async (c) => {
		try {
			const mailbox = mailboxAddress(c.req.param("mailboxId") ?? "");
			const query = normalizeMailPeopleListQuery(new URL(c.req.url).searchParams);
			const read = await dependencies.operations(c).list(mailbox, query).then(
				(value) => ({ status: "success" as const, value }),
				(error: unknown) => ({ status: "failed" as const, error }),
			);
			if (!(await dependencies.revalidateAccess(c))) return c.json({ error: "Forbidden" }, 403);
			if (read.status === "failed") throw read.error;
			const response = validateMailPeopleListResponse(read.value, query);
			return c.json(response);
		} catch (error) {
			if (error instanceof MailPeopleContractError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/people/:personId", async (c) => {
		try {
			const mailbox = mailboxAddress(c.req.param("mailboxId") ?? "");
			const id = personId(c.req.param("personId") ?? "");
			const read = await dependencies.operations(c).detail(mailbox, id).then(
				(value) => ({ status: "success" as const, value }),
				(error: unknown) => ({ status: "failed" as const, error }),
			);
			if (!(await dependencies.revalidateAccess(c))) return c.json({ error: "Forbidden" }, 403);
			if (read.status === "failed") throw read.error;
			const response = validateMailPersonDetailResponse(read.value, id);
			if (response.status === "ready" && response.person === null) {
				return c.json({ error: "Person not found" }, 404);
			}
			return c.json(response);
		} catch (error) {
			if (error instanceof MailPeopleContractError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
	});

	routes.get("/api/v1/mailboxes/:mailboxId/people/:personId/timeline", async (c) => {
		try {
			const mailbox = mailboxAddress(c.req.param("mailboxId") ?? "");
			const id = personId(c.req.param("personId") ?? "");
			const query = normalizeMailPersonTimelineQuery(new URL(c.req.url).searchParams, id);
			const read = await dependencies.operations(c).timeline(mailbox, id, query).then(
				(value) => ({ status: "success" as const, value }),
				(error: unknown) => ({ status: "failed" as const, error }),
			);
			if (!(await dependencies.revalidateAccess(c))) return c.json({ error: "Forbidden" }, 403);
			if (read.status === "failed") throw read.error;
			const response = validateMailPersonTimelineResponse(read.value, id, query);
			return c.json(response);
		} catch (error) {
			if (error instanceof MailPeopleContractError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
	});

	return routes;
}

export const mailPeopleRoutes = createMailPeopleRoutes({
	operations: (c) => ({
		list: (mailbox, query) => c.var.mailboxStub.listMailPeople(mailbox, query),
		detail: (mailbox, id) => c.var.mailboxStub.getMailPerson(mailbox, id),
		timeline: (mailbox, id, query) => c.var.mailboxStub.listMailPersonTimeline(mailbox, id, query),
	}),
	revalidateAccess: hasLiveMailboxContentAccess,
});
