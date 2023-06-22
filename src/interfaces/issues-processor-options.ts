import {IsoOrRfcDateString} from '../types/iso-or-rfc-date-string';

export interface IIssuesProcessorOptions {
  repoToken: string;
  feedbackMessage: string;
  daysBeforeFeedback: number;
  feedbackLabel: string;
  operationsPerRun: number;
  debugOnly: boolean;
  startDate: IsoOrRfcDateString | undefined; // Should be ISO 8601 or RFC 2822
  enableStatistics: boolean;
  exemptDraftPr: boolean;
}
