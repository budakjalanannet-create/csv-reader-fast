// Fast drop-in replacement for csv-reader 1.0.0: same answers, byte for byte, on every input.
// Most records are read by one inlined scanner that walks the record once, slicing fields out of
// the input and jumping between commas with indexOf where that pays. A record containing anything
// unusual (a stray CR, junk after a closing quote, an unterminated quote) is restarted and read by
// the general path below, which follows the reference's behaviour step for step: cached next-LF /
// next-CR positions, quote-to-quote jumps inside quoted fields, and a plain character scanner for
// the messy fields. Errors are recorded in the order met, exactly as the reference records them.

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

  // The field most recently read by readUnquoted / readQuoted (general path).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Cached next-LF and next-CR positions for the record being read; -2 means dirty (refill on use).
  let nLF = -2;
  let nCR = -2;

  function refillBreaks() {
    if (nLF === -2 || (nLF >= 0 && nLF < pos)) nLF = text.indexOf('\n', pos);
    if (nCR === -2 || (nCR >= 0 && nCR < pos)) nCR = text.indexOf('\r', pos);
  }

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
      if (q > i) {
        if (q - i <= 56) {
          let crAt = -1;
          let lf = 0;
          for (let j = i; j < q; j++) {
            const cc = text.charCodeAt(j);
            if (cc === 13) { crAt = j; break; }
            if (cc === 10) lf += 1;
          }
          if (crAt === -1) {
            line += lf;
          } else {
            line += lf + 1;
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, crAt), '\n');
            i = crAt + (text.charCodeAt(crAt + 1) === 10 ? 2 : 1);
            segStart = i;
            continue;
          }
        } else {
          const r = text.indexOf('\r', i);
          if (r !== -1 && r < q) {
            line += countLF(i, r) + 1;
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, r), '\n');
            i = r + (text.charCodeAt(r + 1) === 10 ? 2 : 1);
            segStart = i;
            continue;
          }
          line += countLF(i, q);
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
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
      nLF = -2;
      nCR = -2;
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
    nLF = -2;
    nCR = -2;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    readUnquoted('"');
  }

  // The general record parse: fields into `fields`, sets `quoted` for the record's last field.
  function readRecordGeneral(fields) {
    let quoted = false;
    nLF = -2;
    nCR = -2;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
        fields.push(fValue);
      } else {
        quoted = false;
        refillBreaks();
        const nc = text.indexOf(',', pos);
        if (nc !== -1 && (nLF === -1 || nc < nLF) && (nCR === -1 || nc < nCR)) {
          fields.push(text.slice(pos, nc));
          fEnded = COMMA;
          pos = nc + 1;
        } else if (nCR !== -1 && (nLF === -1 || nCR < nLF)) {
          if (text.charCodeAt(nCR + 1) === 10) {
            fields.push(text.slice(pos, nCR));
            fEnded = LINE_BREAK;
            pos = nCR + 2;
            line += 1;
          } else {
            readUnquoted('');
            fields.push(fValue);
            nLF = -2;
            nCR = -2;
          }
        } else if (nLF !== -1) {
          fields.push(text.slice(pos, nLF));
          fEnded = LINE_BREAK;
          pos = nLF + 1;
          line += 1;
        } else {
          fields.push(text.slice(pos, len));
          fEnded = END;
          pos = len;
        }
      }
    } while (fEnded === COMMA);
    return quoted;
  }

  // The clean record parse: one inlined pass over a record with nothing unusual in it.
  // On success returns the fields array and sets cleanQuoted; on anything unusual returns null
  // (pos and line are then restored by the caller and the general path reads the record).
  let cleanQuoted = false;
  function readRecordClean() {
    const fields = [];
    let i = pos;
    cleanQuoted = false;
    fieldLoop: while (true) {
      if (text.charCodeAt(i) === 34) {
        cleanQuoted = true;
        i += 1;
        let segStart = i;
        let parts = null;
        while (i < len) {
          const c = text.charCodeAt(i);
          if (c === 34) {
            if (text.charCodeAt(i + 1) === 34) {
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i), '"');
              i += 2;
              segStart = i;
              continue;
            }
            let value;
            if (parts === null) {
              value = text.slice(segStart, i);
            } else {
              parts.push(text.slice(segStart, i));
              value = parts.join('');
            }
            i += 1;
            fields.push(value);
            if (i >= len) {
              pos = i;
              return fields;
            }
            const d = text.charCodeAt(i);
            if (d === 44) {
              i += 1;
              continue fieldLoop;
            }
            if (d === 10) {
              i += 1;
              line += 1;
              pos = i;
              return fields;
            }
            if (d === 13 && text.charCodeAt(i + 1) === 10) {
              i += 2;
              line += 1;
              pos = i;
              return fields;
            }
            return null; // junk after the closing quote
          }
          if (c === 13) {
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i), '\n');
            line += 1;
            i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
            segStart = i;
            continue;
          }
          if (c === 10) line += 1;
          i += 1;
        }
        return null; // the quote never closes
      }
      cleanQuoted = false;
      const fs = i;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 44) {
          fields.push(text.slice(fs, i));
          i += 1;
          continue fieldLoop;
        }
        if (c === 10) {
          fields.push(text.slice(fs, i));
          i += 1;
          line += 1;
          pos = i;
          return fields;
        }
        if (c === 13) {
          if (text.charCodeAt(i + 1) === 10) {
            fields.push(text.slice(fs, i));
            i += 2;
            line += 1;
            pos = i;
            return fields;
          }
          return null; // a stray CR
        }
        i += 1;
      }
      fields.push(text.slice(fs, len));
      pos = len;
      return fields;
    }
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
    const savePos = pos;
    const saveLine = line;
    let fields = readRecordClean();
    let quoted;
    if (fields !== null) {
      quoted = cleanQuoted;
    } else {
      pos = savePos;
      line = saveLine;
      fields = [];
      quoted = readRecordGeneral(fields);
    }

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
