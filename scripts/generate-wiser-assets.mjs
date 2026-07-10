// Generate every raster asset from the tracked Wiser SVG mark. Keeping this
// reproducible avoids hand-edited icon drift between the PWA, push, and OAuth.

import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public/wiser-mark.svg");
const output = (filename) => path.join(root, "public", filename);
const background = "#f9f7f3";

async function markBuffer(size) {
	return sharp(source, { density: 384 })
		.resize(size, size, { fit: "contain" })
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
		.composite([{ input: await markBuffer(markSize), gravity: "center" }])
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
		.composite([{ input: await markBuffer(markSize), gravity: "center" }])
		.png({ compressionLevel: 9, palette: true })
		.toFile(output(filename));
}

await Promise.all([
	opaqueIcon("wiser-icon-192.png", 192, 112),
	opaqueIcon("wiser-icon-512.png", 512, 300),
	opaqueIcon("wiser-apple-touch-icon.png", 180, 108),
	transparentIcon("wiser-favicon-32.png", 32, 28),
	transparentIcon("wiser-badge-96.png", 96, 64),
]);
