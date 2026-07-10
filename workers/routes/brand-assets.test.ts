import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

test("Wiser install and notification assets have their declared PNG dimensions", async () => {
	const expected = new Map([
		["wiser-icon-192.png", [192, 192]],
		["wiser-icon-512.png", [512, 512]],
		["wiser-apple-touch-icon.png", [180, 180]],
		["wiser-favicon-32.png", [32, 32]],
		["wiser-badge-96.png", [96, 96]],
	]);

	for (const [filename, [width, height]] of expected) {
		const metadata = await sharp(path.join(publicDir, filename)).metadata();
		assert.equal(metadata.format, "png", `${filename} format`);
		assert.equal(metadata.width, width, `${filename} width`);
		assert.equal(metadata.height, height, `${filename} height`);
	}
});

test("Wiser install icons are opaque while favicon and badge preserve transparency", async () => {
	for (const filename of [
		"wiser-icon-192.png",
		"wiser-icon-512.png",
		"wiser-apple-touch-icon.png",
	]) {
		const metadata = await sharp(path.join(publicDir, filename)).metadata();
		assert.equal(metadata.hasAlpha, false, `${filename} must have an opaque background`);
	}

	for (const filename of ["wiser-favicon-32.png", "wiser-badge-96.png"]) {
		const metadata = await sharp(path.join(publicDir, filename)).metadata();
		assert.equal(metadata.hasAlpha, true, `${filename} must preserve transparency`);
	}
});
