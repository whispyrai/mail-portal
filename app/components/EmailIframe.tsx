// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Force every link in rendered email HTML to open in a new tab. Email anchors
// usually carry no `target`, so inside the sandboxed iframe a click would
// navigate the iframe's own browsing context — replacing the email with the
// linked page. Stamp target + rel on every <a> so links escape the iframe.
// Registered once (module-scoped flag) and only on the client, since the hook
// touches the DOM.
let linkTargetHookRegistered = false;
function ensureLinkTargetHook() {
	if (linkTargetHookRegistered) return;
	linkTargetHookRegistered = true;
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		if (node.nodeName === "A") {
			node.setAttribute("target", "_blank");
			node.setAttribute("rel", "noopener noreferrer");
		}
	});
}

interface EmailIframeProps {
	messageId: string;
	body: string;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
}

/**
 * Renders email HTML inside a sandboxed iframe.
 *
 * Security model:
 * - DOMPurify sanitises the HTML before injection.
 * - The iframe sandbox does NOT include `allow-same-origin`, so even if
 *   DOMPurify has a bypass the attacker's code runs in an opaque origin
 *   with no access to the parent page's cookies, DOM, or API.
 * - Because the iframe is cross-origin we cannot read `contentDocument`
 *   for auto-sizing. Instead, the injected HTML includes a tiny inline
 *   script that posts its body height to the parent via `postMessage`.
 *   The `allow-scripts` flag is required for this, but scripts inside
 *   the opaque-origin sandbox cannot access anything useful.
 * - A strict CSP meta tag blocks external resource loads inside the
 *   iframe as a defense-in-depth layer.
 * - `allow-popups-to-escape-sandbox` lets links the user clicks open as
 *   normal, full-origin tabs. Without it, popups inherit this iframe's
 *   sandbox (no `allow-same-origin` -> opaque "null" origin) and the
 *   destination app crashes reading cookies/localStorage. This flag only
 *   affects newly-opened tabs; the email body itself stays fully
 *   sandboxed with no same-origin access to the parent page.
 */
export default function EmailIframe({ messageId, body, autoSize }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(autoSize ? 100 : 0);
	const [remoteImagesForMessageId, setRemoteImagesForMessageId] = useState<
		string | null
	>(null);
	const loadRemoteImages = remoteImagesForMessageId === messageId;
	const hasRemoteImages = useMemo(
		() => /<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\//i.test(body),
		[body],
	);

	// Listen for height reports from the sandboxed iframe
	const handleMessage = useCallback(
		(event: MessageEvent) => {
			if (!autoSize) return;
			// Only accept messages from our own iframe
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.__emailIframeHeight &&
				typeof event.data.height === "number" &&
				event.data.height > 0
			) {
				setHeight(event.data.height);
			}
		},
		[autoSize],
	);

	useEffect(() => {
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [handleMessage]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !body) return;

		ensureLinkTargetHook();

		let cleanBody = DOMPurify.sanitize(body, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["style"],
			ADD_ATTR: ["target"],
			FORCE_BODY: true,
		});

		if (!loadRemoteImages) {
			const template = document.createElement("template");
			template.innerHTML = cleanBody;
			for (const image of template.content.querySelectorAll("img")) {
				const source = image.getAttribute("src")?.trim() ?? "";
				if (/^https?:\/\//i.test(source)) {
					image.removeAttribute("src");
					image.setAttribute("data-remote-image-blocked", "true");
					image.setAttribute(
						"alt",
						image.getAttribute("alt") || "Remote image blocked for privacy",
					);
				}
			}
			cleanBody = template.innerHTML;
		}

		const padding = autoSize ? "0" : "24px";

		// Height-reporting script: sends body.scrollHeight to the parent.
		// Runs inside the opaque-origin sandbox so it has zero access to
		// the parent page — it can only postMessage.
		const heightScript = autoSize
			? `<script>
				function reportHeight() {
					var h = document.body.scrollHeight;
					if (h > 0) parent.postMessage({ __emailIframeHeight: true, height: h }, "*");
				}
				reportHeight();
				setTimeout(reportHeight, 50);
				setTimeout(reportHeight, 150);
				setTimeout(reportHeight, 400);
			<\/script>`
			: "";

		// Use srcdoc so the iframe is truly sandboxed (no same-origin access).
		// We can't use doc.write() because that requires allow-same-origin.
		iframe.srcdoc = `<!DOCTYPE html>
<html>
<head>
<base target="_blank">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${loadRemoteImages ? " https:" : ""}; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; }
html {
	background: #ffffff;
	color-scheme: light;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: 14px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	padding: ${padding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
blockquote {
	border-left: 3px solid #d1d5db;
	padding-left: 1em;
	margin-left: 0;
	color: #6b7280;
}
pre {
	background: #f3f4f6;
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 4px 0; }
h1, h2, h3 { margin: 8px 0 4px; }
ul, ol { padding-left: 20px; margin: 4px 0; }
</style>
</head>
<body>${cleanBody}${heightScript}</body>
</html>`;
	}, [body, autoSize, loadRemoteImages]);

	const frame = (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
			title="Email content"
		/>
	);

	if (!hasRemoteImages) return frame;

	return (
		<div className={autoSize ? "w-full" : "flex h-full w-full flex-col"}>
			<div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
				<span>
					{loadRemoteImages
						? "Remote images are visible for this message."
						: "Remote images are blocked to protect your privacy."}
				</span>
				<button
					type="button"
					className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 shadow-sm hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
					onClick={() =>
						setRemoteImagesForMessageId((current) =>
							current === messageId ? null : messageId,
						)
					}
				>
					{loadRemoteImages ? "Hide images" : "Load images"}
				</button>
			</div>
			{frame}
		</div>
	);
}
