import * as core from '@actions/core';
import {IssuesProcessor} from './classes/issues-processor';
import {isValidDate} from './functions/dates/is-valid-date';
import {IIssuesProcessorOptions} from './interfaces/issues-processor-options';

async function _run(): Promise<void> {
  try {
    const args = _getAndValidateArgs();

    const issueProcessor: IssuesProcessor = new IssuesProcessor(args);
    await issueProcessor.processIssues();
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

function _getAndValidateArgs(): IIssuesProcessorOptions {
  const args: IIssuesProcessorOptions = {
    repoToken: core.getInput('repo-token'),
    feedbackMessage: core.getInput('feedback-message'),
    daysBeforeFeedback: parseFloat(
      core.getInput('days-before-feedback', {required: true})
    ),
    feedbackLabel: core.getInput('feedback-label', {required: true}),
    operationsPerRun: parseInt(
      core.getInput('operations-per-run', {required: true})
    ),
    debugOnly: core.getInput('debug-only') === 'true',
    enableStatistics: core.getInput('enable-statistics') === 'true',
    startDate:
      core.getInput('start-date') !== ''
        ? core.getInput('start-date')
        : '2023-05-01',
    exemptDraftPr: core.getInput('exempt-draft-pr') === 'true',
    exemptLabels: core.getInput('exempt-labels'),
    exemptAuthors: core.getInput('exempt-authors'),
  };

  for (const numberInput of ['days-before-feedback']) {
    if (isNaN(parseFloat(core.getInput(numberInput)))) {
      const errorMessage = `Option "${numberInput}" did not parse to a valid float`;
      core.setFailed(errorMessage);
      throw new Error(errorMessage);
    }
  }

  for (const optionalDateInput of ['start-date']) {
    // Ignore empty dates because it is considered as the right type for a default value (so a valid one)
    if (core.getInput(optionalDateInput) !== '') {
      if (!isValidDate(new Date(core.getInput(optionalDateInput)))) {
        const errorMessage = `Option "${optionalDateInput}" did not parse to a valid date`;
        core.setFailed(errorMessage);
        throw new Error(errorMessage);
      }
    }
  }

  return args;
}

void _run();
