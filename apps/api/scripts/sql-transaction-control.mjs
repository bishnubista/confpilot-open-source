/** Tokenize only the SQL structure the transaction guard needs. */
function sqlTokens(script) {
  const tokens = [];
  for (let index = 0; index < script.length;) {
    const character = script[index];
    const next = script[index + 1];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "-" && next === "-") {
      index = script.indexOf("\n", index + 2);
      if (index === -1) break;
    } else if (character === "/" && next === "*") {
      const end = script.indexOf("*/", index + 2);
      index = end === -1 ? script.length : end + 2;
    } else if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      index += 1;
      while (index < script.length) {
        if (script[index] !== quote) index += 1;
        else if (script[index + 1] === quote) index += 2;
        else { index += 1; break; }
      }
    } else if (character === "[") {
      const end = script.indexOf("]", index + 1);
      index = end === -1 ? script.length : end + 1;
    } else if (character === ";") {
      tokens.push({ kind: "semicolon" });
      index += 1;
    } else if (/[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < script.length && /[A-Za-z0-9_$]/.test(script[end])) end += 1;
      tokens.push({ kind: "word", value: script.slice(index, end).toUpperCase() });
      index = end;
    } else {
      index += 1;
    }
  }
  return tokens;
}

function triggerStatement(words) {
  return words[0] === "CREATE"
    && (words[1] === "TRIGGER"
      || ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
}

function transactionControl(words) {
  return ["BEGIN", "COMMIT", "END", "ROLLBACK"].includes(words[0]) ? words[0] : null;
}

/**
 * Refuse SQL that can escape an outer transaction.
 *
 * Trigger BEGIN/END pairs are SQL grammar rather than transaction control. CASE
 * expressions inside them have their own END tokens, so CASE depth is tracked
 * before treating END followed by a semicolon as the trigger terminator.
 */
export function refuseTransactionControl(label, script) {
  let words = [];
  let inTrigger = false;
  let triggerBody = false;
  let triggerEnd = false;
  let caseDepth = 0;

  const finishStatement = () => {
    const control = transactionControl(words);
    if (control) {
      throw new Error(
        `${label} manages its own transaction (${control}), which would commit part of the run and leave `
        + "the rest unapplied while the caller reports a rollback. Remove the transaction control.",
      );
    }
    words = [];
  };

  for (const token of sqlTokens(script)) {
    if (token.kind === "semicolon") {
      if (inTrigger) {
        if (triggerEnd) {
          inTrigger = false;
          triggerBody = false;
          triggerEnd = false;
          caseDepth = 0;
          words = [];
        }
      } else {
        finishStatement();
      }
      continue;
    }

    if (!inTrigger) {
      words.push(token.value);
      if (triggerStatement(words)) inTrigger = true;
      continue;
    }

    if (!triggerBody) {
      if (token.value === "BEGIN") triggerBody = true;
      continue;
    }

    if (token.value === "CASE") {
      caseDepth += 1;
      triggerEnd = false;
    } else if (token.value === "END") {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerEnd = true;
    } else if (triggerEnd) {
      triggerEnd = false;
    }
  }

  if (!inTrigger && words.length > 0) finishStatement();
}
