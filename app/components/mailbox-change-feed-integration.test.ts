import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("MailboxRoute owns exactly one mailbox change feed for its active mailbox", () => {
	const source = readFileSync(
		new URL("../routes/mailbox.tsx", import.meta.url),
		"utf8",
	);
	assert.match(source, /import \{ useMailboxChangeFeed \} from "~\/queries\/mailbox-change-feed"/);
	assert.equal(source.match(/useMailboxChangeFeed\(mailboxId\)/g)?.length, 1);

	const feed = readFileSync(
		new URL("../queries/mailbox-change-feed.ts", import.meta.url),
		"utf8",
	);
	assert.match(feed, /const navigate = useNavigate\(\)/);
	assert.match(feed, /onAccessLost: \(\) => navigate\("\/", \{ replace: true \}\)/);
});
