import * as core from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {GitHub} from '@actions/github/lib/utils';
import {Option} from '../enums/option';
import {getHumanizedDate} from '../functions/dates/get-humanized-date';
import {isDateMoreRecentThan} from '../functions/dates/is-date-more-recent-than';
import {isValidDate} from '../functions/dates/is-valid-date';
import {cleanLabel} from '../functions/clean-label';
import {shouldMarkWhenStale} from '../functions/should-mark-when-stale';
import {IComment} from '../interfaces/comment';
import {IIssueEvent} from '../interfaces/issue-event';
import {IIssuesProcessorOptions} from '../interfaces/issues-processor-options';
import {IPullRequest} from '../interfaces/pull-request';
import {ExemptDraftPullRequest} from './exempt-draft-pull-request';
import {Issue} from './issue';
import {IssueLogger} from './loggers/issue-logger';
import {Logger} from './loggers/logger';
import {StaleOperations} from './stale-operations';
import {Statistics} from './statistics';
import {LoggerService} from '../services/logger.service';
import {OctokitIssue} from '../interfaces/issue';
import {retry} from '@octokit/plugin-retry';
import {wordsToList} from "../functions/words-to-list";
import {isLabeled} from "../functions/is-labeled";

/***
 * Handle processing of issues for staleness/closure.
 */
export class IssuesProcessor {
  private static _updatedSince(timestamp: string, num_days: number): boolean {
    const daysInMillis = 1000 * 60 * 60 * 24 * num_days;
    const millisSinceLastUpdated =
      new Date().getTime() - new Date(timestamp).getTime();

    return millisSinceLastUpdated <= daysInMillis;
  }

  private static _endIssueProcessing(issue: Issue): void {
    const consumedOperationsCount: number =
      issue.operations.getConsumedOperationsCount();

    if (consumedOperationsCount > 0) {
      const issueLogger: IssueLogger = new IssueLogger(issue);

      issueLogger.info(
        LoggerService.cyan(consumedOperationsCount),
        `operation${
          consumedOperationsCount > 1 ? 's' : ''
        } consumed for this $$type`
      );
    }
  }

  readonly operations: StaleOperations;
  readonly client: InstanceType<typeof GitHub>;
  readonly options: IIssuesProcessorOptions;
  readonly staleIssues: Issue[] = [];
  readonly closedIssues: Issue[] = [];
  readonly deletedBranchIssues: Issue[] = [];
  readonly removedLabelIssues: Issue[] = [];
  readonly addedLabelIssues: Issue[] = [];
  readonly addedCloseCommentIssues: Issue[] = [];
  readonly statistics: Statistics | undefined;
  private readonly _logger: Logger = new Logger();

  constructor(options: IIssuesProcessorOptions) {
    this.options = options;
    this.client = getOctokit(this.options.repoToken, undefined, retry);
    this.operations = new StaleOperations(this.options);

    this._logger.info(
      LoggerService.yellow(`Starting the feedback action process...`)
    );

    if (this.options.debugOnly) {
      this._logger.warning(
        LoggerService.yellowBright(`Executing in debug mode!`)
      );
      this._logger.warning(
        LoggerService.yellowBright(
          `The debug output will be written but no issues/PRs will be processed.`
        )
      );
    }

    if (this.options.enableStatistics) {
      this.statistics = new Statistics();
    }
  }

  async processIssues(page: Readonly<number> = 1): Promise<number> {
    // get the next batch of issues
    const issues: Issue[] = await this.getIssues(page);

    if (issues.length <= 0) {
      this._logger.info(
        LoggerService.green(`No more issues found to process. Exiting...`)
      );
      this.statistics
        ?.setOperationsCount(this.operations.getConsumedOperationsCount())
        .logStats();

      return this.operations.getRemainingOperationsCount();
    } else {
      this._logger.info(
        `${LoggerService.yellow(
          'Processing the batch of issues '
        )} ${LoggerService.cyan(`#${page}`)} ${LoggerService.yellow(
          ' containing '
        )} ${LoggerService.cyan(issues.length)} ${LoggerService.yellow(
          ` issue${issues.length > 1 ? 's' : ''}...`
        )}`
      );
    }

    for (const issue of issues.values()) {
      // Stop the processing if no more operations remains
      if (!this.operations.hasRemainingOperations()) {
        break;
      }

      const issueLogger: IssueLogger = new IssueLogger(issue);
      await issueLogger.grouping(`$$type #${issue.number}`, async () => {
        await this.processIssue(issue);
      });
    }

    if (!this.operations.hasRemainingOperations()) {
      this._logger.warning(
        LoggerService.yellowBright(`No more operations left! Exiting...`)
      );
      this._logger.warning(
        `${LoggerService.yellowBright(
          'If you think that not enough issues were processed you could try to increase the quantity related to the '
        )} ${this._logger.createOptionLink(
          Option.OperationsPerRun
        )} ${LoggerService.yellowBright(
          ' option which is currently set to '
        )} ${LoggerService.cyan(this.options.operationsPerRun)}`
      );
      this.statistics
        ?.setOperationsCount(this.operations.getConsumedOperationsCount())
        .logStats();

      return 0;
    }

    this._logger.info(
      `${LoggerService.green('Batch ')} ${LoggerService.cyan(
        `#${page}`
      )} ${LoggerService.green(' processed.')}`
    );

    // Do the next batch
    return this.processIssues(page + 1);
  }

  async processIssue(issue: Issue): Promise<void> {
    this.statistics?.incrementProcessedItemsCount(issue);

    const issueLogger: IssueLogger = new IssueLogger(issue);
    issueLogger.info(
      `Found this $$type last updated at: ${LoggerService.cyan(
        issue.updated_at
      )}`
    );

    // calculate string based messages for this issue
    const feedbackMessage: string = this.options.feedbackMessage;
    const feedbackLabel: string = this.options.feedbackLabel;
    const daysBeforeFeedback: number = this._getDaysBeforeFeedback();

    if (issue.locked) {
      issueLogger.info(`Skipping this $$type because it is locked`);
      IssuesProcessor._endIssueProcessing(issue);
      return; // Don't process locked issues
    }

    if (!issue.isPullRequest) {
      issueLogger.info(`Skipping this $$type because it is not a pull request`);
      IssuesProcessor._endIssueProcessing(issue);
      return; // Don't process pull request issues
    }

    issueLogger.info(
      `Days before feedback: ${LoggerService.cyan(daysBeforeFeedback)}`
    );

    const shouldAskForFeedback: boolean =
      shouldMarkWhenStale(daysBeforeFeedback);

    if (this.options.startDate) {
      const startDate: Date = new Date(this.options.startDate);
      const createdAt: Date = new Date(issue.created_at);

      issueLogger.info(
        `A start date was specified for the ${getHumanizedDate(
          startDate
        )} (${LoggerService.cyan(this.options.startDate)})`
      );

      // Expecting that GitHub will always set a creation date on the issues and PRs
      // But you never know!
      if (!isValidDate(createdAt)) {
        IssuesProcessor._endIssueProcessing(issue);
        core.setFailed(
          new Error(`Invalid issue field: "created_at". Expected a valid date`)
        );
      }

      issueLogger.info(
        `$$type created the ${getHumanizedDate(
          createdAt
        )} (${LoggerService.cyan(issue.created_at)})`
      );

      if (!isDateMoreRecentThan(createdAt, startDate)) {
        issueLogger.info(
          `Skipping this $$type because it was created before the specified start date`
        );

        IssuesProcessor._endIssueProcessing(issue);
        return; // Don't process issues which were created before the start date
      }
    }

    if (issue.askedForFeedback) {
      issueLogger.info(`This $$type includes a feedback label`);
    } else {
      issueLogger.info(`This $$type does not include a feedback label`);
    }

    const exemptLabels: string[] = wordsToList(this.options.exemptLabels);

    const hasExemptLabel = exemptLabels.some((exemptLabel: Readonly<string>) =>
        isLabeled(issue, exemptLabel)
    );

    if (hasExemptLabel) {
      issueLogger.info(
          `Skipping this $$type because it contains an exempt label, see ${issueLogger.createOptionLink(
              Option.ExemptLabels
          )} for more details`
      );
      IssuesProcessor._endIssueProcessing(issue);
      return; // Don't process exempt issues
    }

    const exemptAuthors: string[] = wordsToList(this.options.exemptAuthors);
    const isExemptAuthor = exemptAuthors.some(exemptAuthor => exemptAuthor === issue.user)

    if (isExemptAuthor) {
      issueLogger.info(
          `Skipping this $$type because its author is an exempt author, see ${issueLogger.createOptionLink(
              Option.ExemptAuthors
          )} for more details`
      );
      IssuesProcessor._endIssueProcessing(issue);
      return; // Don't process exempt issues
    }

    // Ignore draft PR
    // Note that this check is so far below because it cost one read operation
    // So it's simply better to do all the stale checks which don't cost more operation before this one
    const exemptDraftPullRequest: ExemptDraftPullRequest =
      new ExemptDraftPullRequest(this.options, issue);

    if (
      await exemptDraftPullRequest.shouldExemptDraftPullRequest(
        async (): Promise<IPullRequest | undefined | void> => {
          return this.getPullRequest(issue);
        }
      )
    ) {
      IssuesProcessor._endIssueProcessing(issue);
      return; // Don't process draft PR
    }

    // Determine if this issue needs to be marked stale first
    if (!issue.askedForFeedback) {
      issueLogger.info(`This $$type is not marked as feedback`);

      // Should this issue be marked as stale?
      const shouldAskForFeedback = !IssuesProcessor._updatedSince(
        issue.created_at,
        daysBeforeFeedback
      );

      if (shouldAskForFeedback) {
        issueLogger.info(
          `This $$type should be marked as stale based on the option ${issueLogger.createOptionLink(
            this._getDaysBeforeFeedbackOptionName(issue)
          )} (${LoggerService.cyan(daysBeforeFeedback)})`
        );
        await this._askForFeedback(issue, feedbackMessage, feedbackLabel);
        issue.askedForFeedback = true; // This issue is now considered stale
        issue.markedStaleThisRun = true;
        issueLogger.info(`This $$type is now asking for feedback`);
      } else {
        issueLogger.info(
          `This $$type should not be marked as asking for feedback based on the option ${issueLogger.createOptionLink(
            this._getDaysBeforeFeedbackOptionName(issue)
          )} (${LoggerService.cyan(daysBeforeFeedback)})`
        );
      }
    }

    IssuesProcessor._endIssueProcessing(issue);
  }

  // Grab comments for an issue since a given date
  async listIssueComments(
    issue: Readonly<Issue>,
    sinceDate: Readonly<string>
  ): Promise<IComment[]> {
    // Find any comments since date on the given issue
    try {
      this._consumeIssueOperation(issue);
      this.statistics?.incrementFetchedItemsCommentsCount();
      const comments = await this.client.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        since: sinceDate
      });
      return comments.data;
    } catch (error) {
      this._logger.error(`List issue comments error: ${error.message}`);
      return Promise.resolve([]);
    }
  }

  // grab issues from github in batches of 100
  async getIssues(page: number): Promise<Issue[]> {
    try {
      this.operations.consumeOperation();
      const issueResult = await this.client.rest.issues.listForRepo({
        owner: context.repo.owner,
        repo: context.repo.repo,
        per_page: 100,
        direction: 'asc',
        state: 'all',
        page
      });
      this.statistics?.incrementFetchedItemsCount(issueResult.data.length);

      return issueResult.data.map(
        (issue: Readonly<OctokitIssue>): Issue => new Issue(this.options, issue)
      );
    } catch (error) {
      throw Error(`Getting issues was blocked by the error: ${error.message}`);
    }
  }

  // returns the creation date of a given label on an issue (or nothing if no label existed)
  ///see https://developer.github.com/v3/activity/events/
  async getLabelCreationDate(
    issue: Issue,
    label: string
  ): Promise<string | undefined> {
    const issueLogger: IssueLogger = new IssueLogger(issue);

    issueLogger.info(`Checking for label on this $$type`);

    this._consumeIssueOperation(issue);
    this.statistics?.incrementFetchedItemsEventsCount();
    const options = this.client.rest.issues.listEvents.endpoint.merge({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: 100,
      issue_number: issue.number
    });

    const events: IIssueEvent[] = await this.client.paginate(options);
    const reversedEvents = events.reverse();

    const staleLabeledEvent = reversedEvents.find(
      event =>
        event.event === 'labeled' &&
        cleanLabel(event.label.name) === cleanLabel(label)
    );

    if (!staleLabeledEvent) {
      // Must be old rather than labeled
      return undefined;
    }

    return staleLabeledEvent.created_at;
  }

  async getPullRequest(issue: Issue): Promise<IPullRequest | undefined | void> {
    const issueLogger: IssueLogger = new IssueLogger(issue);

    try {
      this._consumeIssueOperation(issue);
      this.statistics?.incrementFetchedPullRequestsCount();

      const pullRequest = await this.client.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: issue.number
      });

      return pullRequest.data;
    } catch (error) {
      issueLogger.error(`Error when getting this $$type: ${error.message}`);
    }
  }

  // Mark an issue as stale with a comment and a label
  private async _askForFeedback(
    issue: Issue,
    feedbackMessage: string,
    feedbackLabel: string
  ): Promise<void> {
    const issueLogger: IssueLogger = new IssueLogger(issue);

    issueLogger.info(`Marking this $$type for feedback`);
    this.staleIssues.push(issue);

    // if the issue is being marked stale, the updated date should be changed to right now
    // so that close calculations work correctly
    const newUpdatedAtDate: Date = new Date();
    issue.updated_at = newUpdatedAtDate.toString();

    try {
      this._consumeIssueOperation(issue);
      this.statistics?.incrementAddedItemsComment(issue);

      if (!this.options.debugOnly) {
        await this.client.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: issue.number,
          body: feedbackMessage
        });
      }
    } catch (error) {
      issueLogger.error(`Error when creating a comment: ${error.message}`);
    }

    try {
      this._consumeIssueOperation(issue);
      this.statistics?.incrementAddedItemsLabel(issue);
      this.statistics?.incrementStaleItemsCount(issue);

      if (!this.options.debugOnly) {
        await this.client.rest.issues.addLabels({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: issue.number,
          labels: [feedbackLabel]
        });
      }
    } catch (error) {
      issueLogger.error(`Error when adding a label: ${error.message}`);
    }
  }

  private _getDaysBeforeFeedback(): number {
    return this.options.daysBeforeFeedback;
  }

  private _consumeIssueOperation(issue: Readonly<Issue>): void {
    this.operations.consumeOperation();
    issue.operations.consumeOperation();
  }

  private _getDaysBeforeFeedbackOptionName(
    issue: Readonly<Issue>
  ):
     | Option.DaysBeforeFeedback {
    return Option.DaysBeforeFeedback;
  }

}
