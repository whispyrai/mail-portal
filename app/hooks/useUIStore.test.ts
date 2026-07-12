import assert from "node:assert/strict";
import test from "node:test";
import { useUIStore } from "./useUIStore.ts";

test("closing a message panel never silently closes an active composer", () => {
	useUIStore.setState({
		selectedEmailId: "email-1",
		isComposing: false,
		_previousEmailId: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose();
	useUIStore.getState().closePanel();

	assert.equal(useUIStore.getState().isComposing, true);
	assert.equal(useUIStore.getState().selectedEmailId, null);
});

test("selecting another message never silently closes an active composer", () => {
	useUIStore.setState({
		selectedEmailId: null,
		isComposing: false,
		_previousEmailId: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose();
	useUIStore.getState().selectEmail("email-2");

	assert.equal(useUIStore.getState().isComposing, true);
	assert.equal(useUIStore.getState().selectedEmailId, "email-2");
});
