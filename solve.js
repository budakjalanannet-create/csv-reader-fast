// Fast drop-in replacement for csv-reader 1.0.0: same answers, byte for byte, on every input.
// One left-to-right pass. Unquoted fields are scanned inline and taken as slices of the input;
// quoted fields jump from quote to quote with indexOf. A parts list is built only for the rare
// field that needs characters dropped or rewritten (a stray CR, a doubled quote, a CR in quotes).
// Errors are recorded in the order met, exactly as the reference records them.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The field most recently read by readUnquoted / readQuoted.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function countLF(a, b) {
    let n = 0;
    let j = text.indexOf('\n', a);
    while (j !== -1 && j < b) {
      n += 1;
      j = text.indexOf('\n', j + 1);
    }
    return n;
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Sets fValue, fEnded, fAdded.
  function readUnquoted(prefix) {
    let i = pos;
    let segStart = pos;
    let parts = null;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        fEnded = COMMA;
        pos = i + 1;
        finishUnquoted(prefix, parts, segStart, i);
        return;
      }
      if (c === 10) {
        fEnded = LINE_BREAK;
        pos = i + 1;
        line += 1;
        finishUnquoted(prefix, parts, segStart, i);
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          fEnded = LINE_BREAK;
          pos = i + 2;
          line += 1;
          finishUnquoted(prefix, parts, segStart, i);
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i));
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    fEnded = END;
    pos = len;
    finishUnquoted(prefix, parts, segStart, len);
  }

  function finishUnquoted(prefix, parts, segStart, end) {
    if (parts === null) {
      fValue = prefix + text.slice(segStart, end);
    } else {
      parts.push(text.slice(segStart, end));
      fValue = prefix + parts.join('');
    }
    fAdded = fValue.length - prefix.length;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue, fEnded (fAdded via readUnquoted on the junk path).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let segStart = i;
    let parts = null;
    while (i < len) {
      const q = text.indexOf('"', i);
      if (q === -1) break; // no closing quote anywhere: unterminated
      const r = text.indexOf('\r', i);
      if (r !== -1 && r < q) {
        // CRLF and a lone CR inside quotes are each one LF.
        line += countLF(i, r) + 1;
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, r), '\n');
        i = r + (text.charCodeAt(r + 1) === 10 ? 2 : 1);
        segStart = i;
        continue;
      }
      line += countLF(i, q);
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, q), '"');
        i = q + 2;
        segStart = i;
        continue;
      }
      // The closing quote.
      const tail = text.slice(segStart, q);
      let value;
      if (parts === null) {
        value = tail;
      } else {
        parts.push(tail);
        value = parts.join('');
      }
      i = q + 1;
      if (i >= len) {
        fValue = value;
        fEnded = END;
        pos = i;
        return;
      }
      const d = text.charCodeAt(i);
      if (d === 44) {
        fValue = value;
        fEnded = COMMA;
        pos = i + 1;
        return;
      }
      if (d === 10) {
        fValue = value;
        fEnded = LINE_BREAK;
        pos = i + 1;
        line += 1;
        return;
      }
      if (d === 13 && text.charCodeAt(i + 1) === 10) {
        fValue = value;
        fEnded = LINE_BREAK;
        pos = i + 2;
        line += 1;
        return;
      }
      // What follows the closing quote is appended as it stands.
      pos = i;
      readUnquoted(value);
      if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
    // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    readUnquoted('"');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
        fields.push(fValue);
      } else {
        quoted = false;
        // Inline unquoted scan: slice the field out; a stray CR delegates the whole field.
        const start = pos;
        let i = pos;
        let delegated = false;
        fEnded = END;
        while (i < len) {
          const c = text.charCodeAt(i);
          if (c === 44) {
            fEnded = COMMA;
            fields.push(text.slice(start, i));
            i += 1;
            break;
          }
          if (c === 10) {
            fEnded = LINE_BREAK;
            fields.push(text.slice(start, i));
            i += 1;
            line += 1;
            break;
          }
          if (c === 13) {
            if (text.charCodeAt(i + 1) === 10) {
              fEnded = LINE_BREAK;
              fields.push(text.slice(start, i));
              i += 2;
              line += 1;
            } else {
              pos = start;
              readUnquoted('');
              fields.push(fValue);
              delegated = true;
            }
            break;
          }
          i += 1;
        }
        if (!delegated) {
          if (fEnded === END) fields.push(text.slice(start, len));
          pos = i;
        }
      }
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
