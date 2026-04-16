import type { ThemeChoice } from "../hooks/useTheme";

type ThemeToggleProps = {
  theme: ThemeChoice;
  onChange: (next: ThemeChoice) => void;
};

const OPTIONS: { value: ThemeChoice; label: string; aria: string }[] = [
  { value: "light", label: "L", aria: "Use light theme" },
  { value: "system", label: "A", aria: "Match system theme" },
  { value: "dark", label: "D", aria: "Use dark theme" }
];

export function ThemeToggle({ theme, onChange }: ThemeToggleProps) {
  return (
    <fieldset className="theme-toggle-options" aria-label="Theme selector">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.aria}
          aria-pressed={theme === option.value}
          className={theme === option.value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
          title={option.aria}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
