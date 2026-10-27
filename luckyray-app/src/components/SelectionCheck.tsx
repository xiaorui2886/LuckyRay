import type { MouseEvent } from "react";
import "./selectionCheck.css";

/** The same quiet selection affordance in every material collection. */
export function SelectionCheck({ checked, label, onClick, className = "" }: {
  checked: boolean; label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; className?: string;
}) {
  return <button type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label}
    className={`selection-check-react ${className}${checked ? " checked" : ""}`} onClick={onClick}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
  </button>;
}
