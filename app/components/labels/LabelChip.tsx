import type { Label, LabelColor } from "~/types";

export const LABEL_COLOR_CLASSES: Record<LabelColor, string> = {
	gray: "bg-slate-100 text-slate-700 border-slate-200",
	red: "bg-red-50 text-red-700 border-red-200",
	orange: "bg-orange-50 text-orange-700 border-orange-200",
	yellow: "bg-amber-50 text-amber-800 border-amber-200",
	green: "bg-emerald-50 text-emerald-700 border-emerald-200",
	teal: "bg-teal-50 text-teal-700 border-teal-200",
	blue: "bg-blue-50 text-blue-700 border-blue-200",
	purple: "bg-purple-50 text-purple-700 border-purple-200",
	pink: "bg-pink-50 text-pink-700 border-pink-200",
};

export default function LabelChip({ label }: { label: Label }) {
	return (
		<span
			className={`inline-flex max-w-36 items-center truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${LABEL_COLOR_CLASSES[label.color]}`}
			title={label.name}
		>
			{label.name}
		</span>
	);
}
