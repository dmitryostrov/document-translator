// Pure module: shared by the server and the browser bundle. No imports.
export type ErrorInfo={message:string;remedy:string;retryable:boolean};

const info=(message:string,remedy:string,retryable=false):ErrorInfo=>({message,remedy,retryable});

export const errorCatalog:Record<string,ErrorInfo>={
  // Documents and formats
  CORRUPT_OR_ENCRYPTED_PDF:info("This PDF cannot be opened.","Try an unencrypted searchable export."),
  CORRUPT_PDF:info("This PDF is damaged and cannot be read.","Re-export the PDF from its source and upload again."),
  ENCRYPTED_PDF_UNSUPPORTED:info("Password-protected PDFs cannot be processed.","Remove the password protection and upload an unencrypted PDF."),
  SCANNED_PDF_UNSUPPORTED:info("This PDF needs OCR.","Upload a searchable text export."),
  PDF_NO_VISIBLE_TEXT:info("This PDF has no visible text to translate.","Upload a PDF that contains selectable text."),
  PDF_PAGE_LIMIT:info("This PDF has more than 250 pages.","Use a PDF with 250 pages or fewer."),
  PDF_VISIBILITY_UNSUPPORTED:info("This PDF has text visibility or layout we cannot safely resolve.","Export a simple searchable PDF."),
  PDF_ANNOTATIONS_UNSUPPORTED:info("This PDF contains annotations that cannot be safely preserved.","Flatten or remove the annotations and upload again."),
  PDF_TEXT_ONLY_CONFIRMATION_REQUIRED:info("This PDF includes images.","Select the text-only acknowledgment and upload again; images will be excluded."),
  DOCUMENT_WORD_LIMIT:info("This document has more than 300,000 words.","Split the document into smaller files."),
  MARKDOWN_UTF8_INVALID:info("This Markdown file is not valid UTF-8.","Save it as UTF-8 and upload again."),
  MARKDOWN_HTML_UNSUPPORTED:info("This Markdown file contains raw HTML, which cannot be translated safely.","Remove the HTML tags and upload again."),
  MARKDOWN_URI_UNSUPPORTED:info("This Markdown file contains links or URIs that cannot be preserved safely.","Convert the links to plain text and upload again."),
  UNICODE_CONCEALMENT_UNSUPPORTED:info("This file contains unsupported hidden or directional control characters.","Export clean visible text."),
  SENSITIVE_MARKING_DETECTED:info("A restricted-content marker was found. This document was blocked before any OpenAI call.","Use a document without restricted-content markers, or handle it through an approved process."),
  FORMAT_UNSUPPORTED:info("This file type is not supported.","Upload a PDF or Markdown (.md) file."),
  FORMAT_FAILED:info("The document parser failed without a specific reason. No incomplete file was published.","Prepare the document again; if it repeats, use a simpler export.",true),
  FORMAT_REQUEST_INVALID:info("The document parser received an invalid request.","Prepare the document again; contact the operator if it repeats."),
  FORMAT_SERVICE_UNAVAILABLE:info("The isolated document parser is unavailable. No incomplete file was published.","Restore the parser service and prepare again.",true),
  FORMAT_SERVICE_BUSY:info("The isolated document parser is busy with other files.","Wait a moment and prepare again.",true),
  FORMAT_SOCKET_INVALID:info("The parser's local socket path is occupied by a file that is not a socket.","Remove the stray file at the configured socket path and restart the parser."),
  UPLOAD_SIZE_LIMIT:info("This file exceeds the current 25 MiB upload limit.","Choose a smaller file or split the document."),
  FILE_REQUIRED:info("No file was included in the upload.","Choose a file and upload again."),
  MULTIPART_INVALID:info("The upload form is malformed or contains a duplicate field.","Upload the file again from the form."),
  LANGUAGE_UNSUPPORTED:info("The target language is not available.","Choose a supported target language."),
  LANGUAGE_SAMPLE_TOO_SHORT:info("The document is too short to detect its language reliably.","Check that the source language is correct."),
  LANGUAGE_SAMPLE_UNCERTAIN:info("The source language could not be determined with confidence.","Check the translation output before use."),
  HIDDEN_TEXT_EXCLUDED:info("Hidden text was excluded from the translation.","Review the output if hidden content was expected."),
  CLIP_REGIONS_NOT_EVALUATED:info("Clipping paths in this PDF were not evaluated, so some text may have been included.","Review the output if the PDF uses clipping masks."),
  TEXT_ONLY_PDF_IMAGES_EXCLUDED:info("Images in this PDF were excluded; only text was translated.","Check the output if images were expected."),

  // Model calls, cost and quality
  OPENAI_KEY_UNAVAILABLE:info("OpenAI is not configured. No model call was made.","Set OPENAI_KEY_PATH to an external readable key file and recreate the worker."),
  PROVIDER_REQUEST_REJECTED:info("OpenAI rejected the request.","Check the worker's model and credential configuration."),
  SAFE_RATE_LIMIT_RETRY:info("The provider repeatedly rejected requests due to rate limits. No translation call was charged.","Try again later.",true),
  MODEL_INPUT_LIMIT:info("This section is too large for a single model request.","Split the document into smaller files."),
  MODEL_RATES_UNCONFIGURED:info("No rates are configured for the selected model.","Configure rates for the model or choose a supported model, then restart the worker."),
  MODEL_CONFIGURATION_CHANGED:info("The configured model changed after approval. This job stopped before another model call.","Prepare a new job and review its quote."),
  INVALID_MODEL_OUTPUT:info("The model response failed a quality or fidelity check. Its cost is recorded; no incomplete artifact was published.","Prepare the job again.",true),
  OUTCOME_UNKNOWN:info("A submitted model request has an uncertain outcome. Checkpoints and its possible charge are preserved.","It will not be repeated automatically; review the receipt before preparing a new job."),
  COST_CAP_REACHED:info("The translation reached its reserved cost limit.","Review the receipt before approving further work."),
  COST_CAP_TOO_LOW:info("The maximum cost is below the reserved amount for this job.","Raise the maximum cost to at least the quoted reserve and start again."),
  QUALITY_PAIR_INSUFFICIENT_EVIDENCE:info("There is not enough reference material to verify translation quality for this language pair.","Review the output with a qualified reviewer before use."),
  QUALITY_REFERENCE_HUMAN_REVIEW_PENDING:info("The German reference check still needs human review.","Have a reviewer confirm the terminology before publishing."),
  CALL_INPUT_CONFLICT:info("A model call reused an identifier with different input.","Prepare a new job; this is an internal consistency check."),
  EVIDENCE_ID_DENIED:info("A quality check requested a source block it is not allowed to read.","Prepare the job again; contact the operator if it repeats."),
  STREAMING_DISABLED:info("Streaming responses are disabled in this configuration.","No action needed; the request is handled without streaming."),
  LIVE_PROVIDER_DISABLED:info("Live model calls are disabled in this configuration.","Enable live provider mode in the worker configuration to translate with OpenAI."),
  FIXTURE_PROVIDER_FAILURE:info("A simulated provider failure was triggered in test mode.","No action needed outside tests."),
  EMPTY_KEY:info("A required configuration key is empty.","Set the key in the worker configuration and restart."),

  // Jobs, approval and lifecycle
  SERVICE_UNAVAILABLE:info("The local service is reconnecting. Accepted jobs are saved.","Progress resumes when the service returns; wait and retry.",true),
  REQUEST_FAILED:info("The request failed without a specific reason.","Try again; if it persists, check the service status.",true),
  PIPELINE_FAILED:info("The job failed for an unexpected reason. No incomplete file was published.","Prepare the job again; contact the operator if it repeats.",true),
  JOB_DEADLINE_EXCEEDED:info("The job did not finish within its deadline. Completed work is preserved.","Review the receipt and prepare a new job for the remaining work.",true),
  LEASE_LOST:info("The worker lost its claim on this job, so its unfinished result was discarded.","Start the job again if it does not resume automatically.",true),
  APPROVAL_EXPIRED:info("The quote expired without approval.","Prepare a new job."),
  QUOTE_STALE:info("The quote no longer matches the configured model or settings.","Prepare the document again and review the new cost before approving."),
  USER_CANCELED:info("You canceled this job. No further model calls will be made.","Prepare a new job if you still want the translation."),
  JOB_NOT_FOUND:info("No job matches this identifier.","Return to your translations and select an existing job."),
  JOB_TERMINAL:info("The job has already finished and cannot be changed.","Prepare a new job to translate the document again."),
  INVALID_JOB_ID:info("The job identifier is not valid.","Check the link or select the job from your list."),
  RERENDER_JOB_NOT_READY:info("The job must finish successfully before its output can be re-rendered.","Wait for the job to succeed, then request the output again."),
  RESUME_NOT_AVAILABLE:info("This job cannot be resumed.","Prepare a new job for the document."),
  RESUME_ACK_REQUIRED:info("Resuming this job requires acknowledging its cost.","Confirm the resume and its cost, then try again."),
  RESUME_LIMIT_REACHED:info("This job has reached its resume limit.","Prepare a new job and review its quote."),
  ARTIFACT_NOT_READY:info("The translation file is not ready yet.","Wait for the job to finish, then try the download again.",true),
  ARTIFACT_INCOMPLETE:info("The translated file was not completed, so nothing was published.","Prepare the document again.",true),
  ARTIFACT_CHECKSUM_MISMATCH:info("The stored translation failed its integrity check and was not delivered.","Prepare the job again; contact the operator if it repeats."),
  IDEMPOTENCY_KEY_REQUIRED:info("The request is missing an Idempotency-Key header.","Send a unique Idempotency-Key with the request."),
  IDEMPOTENCY_CONFLICT:info("This request key was already used for a different request.","Retry with a new request key."),
  INVALID_BUDGET_OR_START_KEY:info("The cost cap or start key is invalid.","Enter a cost cap above 0 and up to 1000 USD, and a valid start key."),

  // Folders and groups
  GROUP_NOT_FOUND:info("This folder translation does not exist.","Check the link or return to your translations."),
  GROUP_APPROVAL_REQUIRED:info("The folder has not been approved yet.","Review the folder quote and approve it before starting."),
  FOLDER_LIMIT:info("The folder must contain 1 to 20 Markdown files totaling 25 MiB or less.","Upload a smaller set of Markdown files."),
  FOLDER_PATH_UNSUPPORTED:info("The folder contains a file with an unsupported name, path, or duplicate name.","Use Markdown files with unique names and no parent-directory segments."),
  FOLDER_PREFLIGHT_PENDING:info("Some files in the folder are still being checked.","Wait for the folder checks to finish, then approve the group.",true),

  // Local paths and origins
  AUTH_REQUIRED:info("The request is missing valid credentials.","Check that the request includes the service credential configured for this instance."),
  ORIGIN_DENIED:info("The request came from a different origin than this service.","Open the workbench from the service's own address."),
  PATH_DENIED:info("The file path is outside the allowed folder.","Choose a file inside the permitted folder."),
  OUTPUT_EXISTS:info("The output file already exists and does not match the expected result.","Remove or rename the existing output file and try again."),
  OUTPUT_PATH_DENIED:info("The output path is outside the allowed folder.","Choose an output location inside the permitted folder.")
};

const fallback=(code?:string):ErrorInfo=>code
  ? info(`Unexpected error (${code}).`,"Try again; if it persists, contact the operator with this code.")
  : info("The operation stopped safely.","Review the receipt and use a supported source.");

export function describeError(code?:string):ErrorInfo{
  return code!==undefined && Object.hasOwn(errorCatalog,code) ? errorCatalog[code]! : fallback(code);
}
