import { execFile } from 'child_process'
import { createRequire } from 'module'
import * as path from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

const PROBE_TIMEOUT = 60 * 1000
const MAX_OUTPUT = 16 * 1024 * 1024

// the pixel formats which carry alpha - 'a' alone would match gray & bayer
const ALPHA_FORMATS = /^(yuva|rgba|bgra|argb|abgr|ya\d|gbrap|pal8)/

/**
 * Where ffprobe is, for this computer: in its @generativenoise/ffprobe-<platform>-<arch>
 * package, the one npm installed of them. It can't run from inside an Electron asar, so
 * it's taken from the unpacked copy that sits beside it.
 * @returns {string} path to the binary
 */
export function ffprobePath(platform = process.platform, arch = process.arch) {
	const name = `@generativenoise/ffprobe-${platform}-${arch}`
	let folder
	try {
		folder = path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`))
	}
	catch {
		throw new Error(`There's no ffprobe for ${platform}-${arch} - install ${name}, or turn off media metadata`)
	}
	return path.join(folder, 'bin', platform == 'win32' ? 'ffprobe.exe' : 'ffprobe').replace('app.asar', 'app.asar.unpacked')
}

/**
 * Run ffprobe on a file. The path is passed as an argument, never via a shell.
 * @param {string} file absolute path to the file
 * @returns {Promise} parsed output of ffprobe
 */
export async function probeFile(file) {
	const { stdout } = await run(
		ffprobePath(),
		['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
		{ timeout: PROBE_TIMEOUT, maxBuffer: MAX_OUTPUT, windowsHide: true }
	)
	return JSON.parse(stdout)
}

const number = (value) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

const round = (value) => Math.round(number(value) * 100) / 100

function frameRate(rate) {
	const [frames, seconds] = String(rate).split('/')
	return number(frames) / number(seconds)
}

// ffprobe says unknown for colour a file isn't tagged with, which is left blank
const colour = value => (!value || value == 'unknown' ? '' : value)

/**
 * A stream's length from its DURATION tag, where Matroska keeps it, like 00:00:09.994000000
 * @param {string} tag
 * @returns {number} seconds, 0 if there isn't one
 */
function tagDuration(tag) {
	const [hours, minutes, seconds] = String(tag ?? '').split(':')
	return seconds === undefined ? 0 : number(hours) * 3600 + number(minutes) * 60 + number(seconds)
}

/**
 * How many frames of video there are, and whether that's counted or worked out.
 * nb_frames is left out by plenty of containers - an H.264 .mp4 hasn't got it where a
 * ProRes or NotchLC .mov of the same thing has - so it falls back to the length times
 * the frame rate, using the video's own length: the file's stretches to whichever
 * stream is longest, and an audio track a little longer than the picture puts it out.
 * @param {object} videoStream ffprobe's video stream, if there is one
 * @param {boolean} videoStill whether it's an image
 * @param {number} fps frames per second
 * @param {number} fileDuration the file's length, if the stream hasn't got one
 * @returns {object} .frames & .framesExact
 */
function frameCount(videoStream, videoStill, fps, fileDuration) {
	if(!videoStream)
		return { frames: 0, framesExact: false }
	// an image is one frame of a sequence, so a folder of them adds up to its length
	if(videoStill)
		return { frames: 1, framesExact: true }

	const counted = number(videoStream.nb_frames)
	if(counted > 0)
		return { frames: Math.round(counted), framesExact: true }

	const duration = number(videoStream.duration) || tagDuration(videoStream.tags?.DURATION) || number(fileDuration)
	return { frames: Math.round(duration * fps), framesExact: false }
}

/**
 * Turn ffprobe's output into the media fields
 * @param {object} probe output of ffprobe, or nothing if the file isn't media
 * @returns {object} values for everything in mediaFileFields' extras
 */
export function mediaValues(probe = {}) {
	const streams = probe.streams ?? []
	const videoStream = streams.find(stream => stream.codec_type == 'video')
	const audioStream = streams.find(stream => stream.codec_type == 'audio')
	const videoStill = probe.format?.format_long_name?.includes('sequence') ?? false
	const pixelFormat = videoStream?.pix_fmt ?? ''
	const fps = frameRate(videoStream?.r_frame_rate)

	return {
		duration: videoStill ? 0 : round(probe.format?.duration),
		video: videoStream !== undefined,
		videoStill,
		videoCodec: videoStream?.codec_name ?? '',
		videoWidth: number(videoStream?.width),
		videoHeight: number(videoStream?.height),
		videoFormat: pixelFormat,
		videoAlpha: ALPHA_FORMATS.test(pixelFormat),
		videoFPS: videoStill ? 0 : round(fps),
		...frameCount(videoStream, videoStill, Number.isFinite(fps) ? fps : 0, probe.format?.duration),
		videoBitRate: number(videoStream?.bit_rate),
		colorPrimaries: colour(videoStream?.color_primaries),
		colorTransfer: colour(videoStream?.color_transfer),
		colorSpace: colour(videoStream?.color_space),
		colorRange: colour(videoStream?.color_range),
		audio: audioStream !== undefined,
		audioCodec: audioStream?.codec_name ?? '',
		audioSampleRate: number(audioStream?.sample_rate),
		audioChannels: number(audioStream?.channels),
		audioBitRate: number(audioStream?.bit_rate)
	}
}
