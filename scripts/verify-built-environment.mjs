// Validate the deployment-ready configuration emitted by the Cloudflare Vite
// plugin. Source wrangler.jsonc assertions alone can miss environment-resolution
// mistakes, so this script inspects the exact artifact Wrangler will deploy.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const brand = process.argv[2];
const environments = {
	whispyr: {
		name: "sales-mail-portal",
		brand: "whispyr",
		domains: "whispyrcrm.com",
		features: ["quiz"],
		databaseName: "sales_portal_users",
		databaseId: "f322fd13-dc49-4390-888c-ff862ca05882",
		bucket: "sales-mail-portal",
		kvId: "cd541026bdf949d9ac63b3b5fdff4969",
		route: "mail.whispyrcrm.com",
		forbidden: [
			"wiser-mail-portal",
			"wiser_mail_portal_users",
			"87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
			"c934d803c2f8430d9088f4a5d9f29d55",
			"wiserchat.ai",
		],
	},
	wiser: {
		name: "wiser-mail-portal",
		brand: "wiser",
		domains: "wiserchat.ai,test.wiserchat.ai",
		features: [],
		databaseName: "wiser_mail_portal_users",
		databaseId: "87c3de98-d31b-4ec3-8e05-d26b4dc71d92",
		bucket: "wiser-mail-portal",
		kvId: "c934d803c2f8430d9088f4a5d9f29d55",
		route: "mail.wiserchat.ai",
		forbidden: [
			"sales-mail-portal",
			"sales_portal_users",
			"f322fd13-dc49-4390-888c-ff862ca05882",
			"cd541026bdf949d9ac63b3b5fdff4969",
			"whispyrcrm.com",
		],
	},
};

assert.ok(brand === "whispyr" || brand === "wiser", "usage: verify-built-environment.mjs <whispyr|wiser>");
const expected = environments[brand];
const config = JSON.parse(await readFile("build/server/wrangler.json", "utf8"));

assert.equal(config.name, expected.name, "Worker name");
assert.equal(config.vars.BRAND, expected.brand, "BRAND");
assert.equal(config.vars.DOMAINS, expected.domains, "DOMAINS");
assert.deepEqual(config.vars.FEATURES, expected.features, "FEATURES");
assert.equal(config.routes[0]?.pattern, expected.route, "custom domain");
assert.equal(config.routes[0]?.custom_domain, true, "custom-domain flag");
assert.equal(config.d1_databases[0]?.database_name, expected.databaseName, "D1 name");
assert.equal(config.d1_databases[0]?.database_id, expected.databaseId, "D1 id");
assert.equal(config.r2_buckets[0]?.bucket_name, expected.bucket, "R2 bucket");
assert.equal(config.r2_buckets[0]?.preview_bucket_name, expected.bucket, "R2 preview bucket");
assert.equal(config.kv_namespaces[0]?.id, expected.kvId, "OAuth KV id");

const serialized = JSON.stringify(config);
for (const forbidden of expected.forbidden) {
	assert.equal(
		serialized.includes(forbidden),
		false,
		`${brand} artifact leaked forbidden identifier ${forbidden}`,
	);
}

console.log(`${brand} built environment is isolated and valid`);
