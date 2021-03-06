import { countBy, chain } from 'lodash';

import { LogLevel, LogRowModel, LogLabelStatsModel, LogsParser } from '../types/logs';
import { DataFrame, FieldType } from '../types/index';
import { ArrayVector } from '../vector/ArrayVector';

// This matches:
// first a label from start of the string or first white space, then any word chars until "="
// second either an empty quotes, or anything that starts with quote and ends with unescaped quote,
// or any non whitespace chars that do not start with qoute
const LOGFMT_REGEXP = /(?:^|\s)(\w+)=(""|(?:".*?[^\\]"|[^"\s]\S*))/;

/**
 * Returns the log level of a log line.
 * Parse the line for level words. If no level is found, it returns `LogLevel.unknown`.
 *
 * Example: `getLogLevel('WARN 1999-12-31 this is great') // LogLevel.warn`
 */
export function getLogLevel(line: string): LogLevel {
  if (!line) {
    return LogLevel.unknown;
  }
  for (const key of Object.keys(LogLevel)) {
    const regexp = new RegExp(`\\b${key}\\b`, 'i');
    if (regexp.test(line)) {
      const level = (LogLevel as any)[key];
      if (level) {
        return level;
      }
    }
  }
  return LogLevel.unknown;
}

export function getLogLevelFromKey(key: string): LogLevel {
  const level = (LogLevel as any)[key];
  if (level) {
    return level;
  }

  return LogLevel.unknown;
}

export function addLogLevelToSeries(series: DataFrame, lineIndex: number): DataFrame {
  const levels = new ArrayVector<LogLevel>();
  const lines = series.fields[lineIndex];
  for (let i = 0; i < lines.values.length; i++) {
    const line = lines.values.get(lineIndex);
    levels.buffer.push(getLogLevel(line));
  }

  return {
    ...series, // Keeps Tags, RefID etc
    fields: [
      ...series.fields,
      {
        name: 'LogLevel',
        type: FieldType.string,
        values: levels,
        config: {},
      },
    ],
  };
}

export function calculateLogsLabelStats(rows: LogRowModel[], label: string): LogLabelStatsModel[] {
  // Consider only rows that have the given label
  const rowsWithLabel = rows.filter(row => row.labels[label] !== undefined);
  const rowCount = rowsWithLabel.length;

  // Get label value counts for eligible rows
  const countsByValue = countBy(rowsWithLabel, row => (row as LogRowModel).labels[label]);
  const sortedCounts = chain(countsByValue)
    .map((count, value) => ({ count, value, proportion: count / rowCount }))
    .sortBy('count')
    .reverse()
    .value();

  return sortedCounts;
}

export const LogsParsers: { [name: string]: LogsParser } = {
  JSON: {
    buildMatcher: label => new RegExp(`(?:{|,)\\s*"${label}"\\s*:\\s*"?([\\d\\.]+|[^"]*)"?`),
    getFields: line => {
      try {
        const parsed = JSON.parse(line);
        return Object.keys(parsed).map(key => {
          return `"${key}":${JSON.stringify(parsed[key])}`;
        });
      } catch {}
      return [];
    },
    getLabelFromField: field => (field.match(/^"([^"]+)"\s*:/) || [])[1],
    getValueFromField: field => (field.match(/:\s*(.*)$/) || [])[1],
    test: line => {
      try {
        return JSON.parse(line);
      } catch (error) {}
    },
  },

  logfmt: {
    buildMatcher: label => new RegExp(`(?:^|\\s)${label}=("[^"]*"|\\S+)`),
    getFields: line => {
      const fields: string[] = [];
      line.replace(new RegExp(LOGFMT_REGEXP, 'g'), substring => {
        fields.push(substring.trim());
        return '';
      });
      return fields;
    },
    getLabelFromField: field => (field.match(LOGFMT_REGEXP) || [])[1],
    getValueFromField: field => (field.match(LOGFMT_REGEXP) || [])[2],
    test: line => LOGFMT_REGEXP.test(line),
  },
};

export function calculateFieldStats(rows: LogRowModel[], extractor: RegExp): LogLabelStatsModel[] {
  // Consider only rows that satisfy the matcher
  const rowsWithField = rows.filter(row => extractor.test(row.entry));
  const rowCount = rowsWithField.length;

  // Get field value counts for eligible rows
  const countsByValue = countBy(rowsWithField, r => {
    const row: LogRowModel = r;
    const match = row.entry.match(extractor);

    return match ? match[1] : null;
  });
  const sortedCounts = chain(countsByValue)
    .map((count, value) => ({ count, value, proportion: count / rowCount }))
    .sortBy('count')
    .reverse()
    .value();

  return sortedCounts;
}

export function getParser(line: string): LogsParser | undefined {
  let parser;
  try {
    if (LogsParsers.JSON.test(line)) {
      parser = LogsParsers.JSON;
    }
  } catch (error) {}

  if (!parser && LogsParsers.logfmt.test(line)) {
    parser = LogsParsers.logfmt;
  }

  return parser;
}
