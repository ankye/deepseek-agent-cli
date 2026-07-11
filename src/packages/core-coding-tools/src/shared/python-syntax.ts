import type { CoreToolDiagnostic } from "@deepseek/platform-contracts";
import { diag } from "./tool-kit.js";

export function pythonSyntaxDiagnostic(path: string, content: string): CoreToolDiagnostic | undefined {
  if (!path.toLowerCase().endsWith(".py")) return undefined;
  const tripleQuote = firstUnclosedPythonTripleQuote(content);
  if (!tripleQuote) return undefined;
  return diag(
    "PYTHON_SYNTAX_INVALID",
    `Mutation would leave invalid Python syntax: unterminated ${tripleQuote.quote} string starting on line ${tripleQuote.line}.`,
    [
      "Retry with exact surrounding context from the current file and preserve Python string delimiters.",
      "Run a standard Python test or parser check after a source mutation before proceeding."
    ]
  );
}

function firstUnclosedPythonTripleQuote(content: string): { readonly quote: string; readonly line: number } | undefined {
  let active: { readonly quote: string; readonly line: number } | undefined;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    let position = 0;
    while (position < line.length) {
      const single = line.indexOf("'''", position);
      const double = line.indexOf("\"\"\"", position);
      const next = nextTripleQuote(single, double);
      if (!next) break;
      if (!active) {
        active = { quote: next.quote, line: index + 1 };
      } else if (active.quote === next.quote) {
        active = undefined;
      }
      position = next.index + 3;
    }
  }
  return active;
}

function nextTripleQuote(single: number, double: number): { readonly quote: string; readonly index: number } | undefined {
  if (single < 0 && double < 0) return undefined;
  if (single >= 0 && (double < 0 || single < double)) return { quote: "'''", index: single };
  return { quote: "\"\"\"", index: double };
}
