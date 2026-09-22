// Generate every raster asset from the tracked Marquista SVG mark (the serif
// "M" of the Marquista wordmark). Install icons are the white mark on the
// site's black; the favicon and push badge keep the black mark on transparent.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public/marquista-mark.svg");
const output = (filename) => path.join(root, "public", filename);
const background = "#0a0a0a";

async function markBuffer(size, fill) {
	const svg = (await readFile(source, "utf8")).replace(/fill="#0a0a0a"/, `fill="${fill}"`);
	return sharp(Buffer.from(svg), { density: 384 })
		.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png({ compressionLevel: 9 })
		.toBuffer();
}

async function opaqueIcon(filename, size, markSize) {
	return sharp({
		create: {
			width: size,
			height: size,
			channels: 3,
			background,
		},
	})
		.composite([{ input: await markBuffer(markSize, "#ffffff"), gravity: "center" }])
		.removeAlpha()
		.png({ compressionLevel: 9, palette: true })
		.toFile(output(filename));
}

async function transparentIcon(filename, size, markSize) {
	return sharp({
		create: {
			width: size,
			height: size,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite([{ input: await markBuffer(markSize, background), gravity: "center" }])
		.png({ compressionLevel: 9, palette: true })
		.toFile(output(filename));
}

await Promise.all([
	opaqueIcon("marquista-icon-192.png", 192, 112),
	opaqueIcon("marquista-icon-512.png", 512, 300),
	opaqueIcon("marquista-apple-touch-icon.png", 180, 108),
	transparentIcon("marquista-favicon-32.png", 32, 30),
	transparentIcon("marquista-badge-96.png", 96, 72),
]);
