/** Strip HTML tags for bounded plain-text display scaffolds. */
export function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Escape all five OWASP-recommended HTML special characters. */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
