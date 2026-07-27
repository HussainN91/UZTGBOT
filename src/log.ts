/**
 * Structured logging.
 *
 * In the Apps Script version errors went to a console nobody opened, which is
 * why "nobody notices when something breaks" is on the concerns list. Logs here
 * are JSON in production so they can be shipped and searched, and the pieces
 * that matter operationally — a scheduled job missing its slot, a sync refusing
 * to run — raise an alert rather than only writing a line.
 */
import { pino } from 'pino';

const level = process.env['LOG_LEVEL'] ?? 'info';
const isProduction = process.env['NODE_ENV'] === 'production';

export const log = pino({
  level,
  /**
   * Nothing that identifies a teacher belongs in a log line. Case *references*
   * are fine and are what staff search by; case *text* is a teacher's own words
   * about a problem they are having and stays in the database, readable only
   * through the commands that check permissions first.
   */
  redact: {
    paths: [
      'token',
      '*.token',
      'botToken',
      '*.botToken',
      'secret',
      '*.secret',
      'password',
      '*.password',
      'detail',
      '*.detail',
      'identifier',
      '*.identifier',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Log = typeof log;
