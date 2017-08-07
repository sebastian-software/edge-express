import codeFrame from "babel-code-frame"
import chalk from "chalk"
import { wrapCallSite } from "source-map-support"
import { readFileSync } from "fs"

const FUNCTION_NAME_FILTERS = [ /__webpack_require__/ ]
const SOURCE_FILE_FILTERS = [ /\/webpack\/bootstrap/ ]

const FUNCTION_NAME_CLEARANCE = [ /__webpack_exports__/ ]
const TYPE_NAME_CLEARANCE = [ /^Object$/ ]

const CODE_FRAME_OPTIONS = {
  highlightCode: true
}


/**
 * Cleans up the source file name which was modified by `source-map-support` to point to the source mapped
 * origin file. Unfortunately instead of giving us the pure source file it resolves into something
 * like "<generatedFile>:<sourceFile>". We take care of this here and remove the generated file segment
 * as this is typically not relevant for the developer.
 *
 * @param {string} sourceFile Sourcefile as being available in the CallSite.
 * @returns {string} Cleaned up plain source file reference.
 */
export function cleanSourceFileName(sourceFile)
{
  var cleanFile = sourceFile.split(":")[1] || sourceFile
  if (cleanFile.charAt(0) === "/") {
    cleanFile = cleanFile.slice(1)
  }

  return cleanFile
}


/**
 * This method checks whether the given stack frame (CallSite) is relevant from a
 * developer perspective.
 *
 * @param {CallSite} frame Incoming frame to check for user relevance.
 * @returns {boolean} Whether the frame is relevant for end developer debugging.
 */
export function isRelevantFrame(frame)
{
  const wrappedFrame = wrapCallSite(frame)
  const generatedFile = frame.getFileName()

  var sourceFile = wrappedFrame.getFileName()
  var functionName = wrappedFrame.getFunctionName()

  // Filter out all raw files which do not have any source mapping
  // This typically removes most of the build related infrastructure
  // which is neither application or framework code.
  const isCompiled = sourceFile !== generatedFile
  if (!isCompiled) {
    return false
  }

  // Filter out specific functions e.g. webpack require wrappers
  if (FUNCTION_NAME_FILTERS.some((regexp) => regexp.test(functionName))) {
    return false
  }

  // Filter out specific source files e.g. webpack bootstrap implementation
  if (SOURCE_FILE_FILTERS.some((regexp) => regexp.test(sourceFile))) {
    return false
  }

  return true
}


/**
 * Filters the existing list of CallSites to drop non user-relevant ones.
 *
 * @param {CallSite[]} frames List of CallSite objects.
 * @returns {CallSite[]} Filtered CallSite list.
 */
export function getRelevantFrames(frames) {
  return frames.filter(isRelevantFrame)
}


/**
 * Processes a single CallSite entry to filter out build tool related or internal APIs.
 * During this process the method also uses source maps to figure out the original source location.
 * The CallSite API is documented in here: https://github.com/v8/v8/wiki/Stack-Trace-API#customizing-stack-traces
 *
 * @param {CallSite} frame The current CallSite object to process.
 * @returns {string} Stringified CallSite object with usage of source maps to refer source location,
 */
export function frameToString(frame)
{
  const wrappedFrame = wrapCallSite(frame)

  var sourceFile = wrappedFrame.getFileName()
  var functionName = wrappedFrame.getFunctionName()
  var typeName = wrappedFrame.getTypeName()

  // Ignore some cryptic function names which typically are just function calls
  if (FUNCTION_NAME_CLEARANCE.some((regexp) => regexp.test(functionName))) {
    functionName = ""
  }

  // Filter out configured type names
  if (TYPE_NAME_CLEARANCE.some((regexp) => regexp.test(typeName))) {
    typeName = ""
  }

  // Strip out generated filename part from source field
  sourceFile = cleanSourceFileName(sourceFile)

  // Retrieve source file locations
  const lineNumber = wrappedFrame.getLineNumber()
  const columnNumber = wrappedFrame.getColumnNumber()

  var identifier = functionName || typeName || "<anonymous>"

  // Stack frames are displayed in the following format:
  //   at FunctionName (<Fully-qualified name/URL>:<line number>:<column number>)
  // Via: https://docs.microsoft.com/en-us/scripting/javascript/reference/stack-property-error-javascript
  return `at ${identifier}@${sourceFile}:${lineNumber}:${columnNumber}`
}


/**
 * Build the stack property for V8 as V8 is documented to use whatever this call returns
 * as the value of the stack property.
 *
 * @param {Error} nativeError Native JavaScript Error Object
 * @param {CallSite[]} structuredStackTrace a structured representation of the stack
 * @returns {String} Generated `stack` property for error object
 */
export function prepareStackTrace(nativeError, structuredStackTrace)
{
  var frames = getRelevantFrames(structuredStackTrace)
  var firstFrame = frames[0]

  // Need the first frame for highlighting affected source code, sometimes that's not available.
  if (firstFrame != null)
  {
    var wrappedFirstFrame = wrapCallSite(firstFrame)
    var sourceFile = cleanSourceFileName(wrappedFirstFrame.getFileName())

    var sourceText = ""
    try {
      sourceText = readFileSync(sourceFile, "utf-8")
    } catch (error) {
      // Ignore errors
    }

    // Generate highlighted code frame and attach it to the native error object (for later usage)
    if (sourceText) {
      const result = codeFrame(sourceText,
        wrappedFirstFrame.getLineNumber(), wrappedFirstFrame.getColumnNumber(), CODE_FRAME_OPTIONS)
      nativeError.code = result
    }
  }

  return frames.map((frame) => frameToString(frame))
    .filter((item) => item != null)
    .join("\n")
}


/**
 * Highlights the given stacktrace object using `chalk
 *
 * @param {Stack} Stacktrace result string
 * @returns {String} Highlighted stack trace for NodeJS
 */
export function highlightStack(stack)
{
  return stack.split("\n").map((line) => {
    if (line.startsWith("at "))
    {
      /* eslint-disable max-params */
      return line.replace(/(at )(.*?)(@)(.*?):([0-9]+)(:)([0-9]+)/,
        (match, intro, id, symbol, filename, lineNo, separator, columnNo) =>
        `  - ${chalk.white(id)} ${chalk.dim(filename)} [${chalk.yellow(lineNo)}:${chalk.yellow(columnNo)}]`)
    }

    return chalk.yellow(line)
  }).join("\n")
}


/**
 * Logs the given error to the NodeJS console
 *
 * @param {Error} nativeError Native JavaScript Error Object
 */
export function logError(nativeError)
{
  /* eslint-disable no-console */
  if (nativeError instanceof Error)
  {
    // Triggering generating formatted stacktrace
    String(nativeError.stack)

    const formattedMessage = chalk.red(nativeError.name + ": " + nativeError.message)
    const formattedStack = highlightStack(nativeError.stack)

    // Optionally display source code except
    if (nativeError.code) {
      console.error(`${formattedMessage}\n\n${nativeError.code}\n\n${formattedStack}`)
    } else {
      console.error(`${formattedMessage}\n\n${formattedStack}`)
    }
  }
  else
  {
    console.error(nativeError)
  }
}


/**
 * Enable enhanced stack traces
 */
export function enableEnhancedStackTraces(debug = false)
{
  // Override native Promise API with faster and more developerr friendly bluebird
  global.Promise = require("bluebird")

  /* eslint-disable no-use-extend-native/no-use-extend-native */
  Promise.config({
    longStackTraces: debug,
    warnings: debug
  })

  // Catch unhandled Promise rejections and pass them over to our log handler
  process.on("unhandledRejection", (reason, promise) => logError(reason))

  // Catch uncaught exceptions and pass them over to our log handler
  process.on("uncaughtException", (error) => logError(error))

  // Enable by hooking into V8 Stacktrace API integration
  // https://github.com/v8/v8/wiki/Stack-Trace-API
  Error.prepareStackTrace = prepareStackTrace

  console.log("Activated enhanced stack traces")
}
