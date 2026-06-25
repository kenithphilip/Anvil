import React, { useState } from "react";
import { Btn, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";

// Small admin editor for a list of string options (e.g. quote line units,
// source countries). Renders the current values as removable chips plus an
// add box. Purely controlled: it calls onChange with the next array; the
// parent owns persistence. Dedup is case-insensitive.

export const OptionListEditor: React.FC<{
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
}> = ({ label, values, onChange, placeholder, hint }) => {
  const [entry, setEntry] = useState("");

  const add = () => {
    const v = entry.trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) { setEntry(""); return; }
    onChange([...values, v]);
    setEntry("");
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {values.length === 0
          ? <span className="mono-sm" style={{ color: "var(--ink-4)" }}>No values yet — free text remains allowed on the quote.</span>
          : values.map((v) => (
              <Chip key={v} k="ghost">
                <span className="mono-sm">{v}</span>
                <span role="button" tabIndex={0} aria-label={"Remove " + v} title="Remove"
                      style={{ cursor: "pointer", marginLeft: 6, color: "var(--ink-3)" }}
                      onClick={() => remove(v)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") remove(v); }}>×</span>
              </Chip>
            ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input mono"
          style={{ maxWidth: 220 }}
          value={entry}
          placeholder={placeholder || "add a value"}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <Btn sm kind="ghost" onClick={add} disabled={!entry.trim()}>{Icon.plus} Add</Btn>
      </div>
      {hint && <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{hint}</span>}
    </div>
  );
};

export default OptionListEditor;
