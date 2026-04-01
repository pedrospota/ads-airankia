const MODEL_COLORS: Record<string, string> = {
  "ChatGPT Search": "bg-green-500/20 text-green-400 border-green-500/30",
  "GPT Search": "bg-green-500/20 text-green-400 border-green-500/30",
  "Grok Search": "bg-blue-500/20 text-blue-400 border-blue-500/30",
  "Claude Search": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  "Gemini Search": "bg-purple-500/20 text-purple-400 border-purple-500/30",
  Perplexity: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  "Perplexity Search": "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
};

const DEFAULT_COLOR = "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";

export function ModelPill({ model }: { model: string }) {
  const color = MODEL_COLORS[model] || DEFAULT_COLOR;
  const shortName = model.replace(" Search", "");

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${color}`}
    >
      {shortName}
    </span>
  );
}
