import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedUrlencodedForm } from "./bounded-urlencoded-form.ts";

const rules = {
  email: { required: true, maxBytes: 254 },
};

function request(body: string) {
  return new Request("https://mail.wiserchat.ai/account/recover/request", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

test("bounded forms return a null-prototype exact field record", async () => {
  const parsed = await readBoundedUrlencodedForm(
    request("email=member%40wiserchat.ai"),
    { maxBytes: 1_024, fields: rules },
  );
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual({ ...parsed }, { email: "member@wiserchat.ai" });
});

for (const inheritedName of ["__proto__", "constructor", "toString"]) {
  test(`bounded forms reject inherited field name ${inheritedName}`, async () => {
    await assert.rejects(() =>
      readBoundedUrlencodedForm(
        request(`email=member%40wiserchat.ai&${inheritedName}=hostile`),
        { maxBytes: 1_024, fields: rules },
      ),
    );
  });
}
