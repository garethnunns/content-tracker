import { promises as fs } from 'fs'
import * as path from 'path'
import PQueue from 'p-queue'
import { isAllowed } from './config.js'
import { MetadataCache } from './cache.js'
import { mediaValues, probeFile } from './probe.js'
import { finderSize } from './format.js'
import { silentLogger } from './logger.js'

const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The path within the project, as a unix style path
 * @param {string} fullPath
 * @param {string} rootPath what's removed from the start of it
 * @returns {string} the project's own root is /
 */
export function projectPath(fullPath, rootPath = '') {
	const insideRoot = rootPath.endsWith(path.sep)
		? fullPath.startsWith(rootPath)
		: fullPath == rootPath || fullPath.startsWith(rootPath + path.sep)
	const relative = rootPath && insideRoot ? fullPath.slice(rootPath.length) : fullPath

	return relative.replaceAll(path.sep, path.posix.sep) || path.posix.sep
}

/**
 * Scan the folders recursively
 * @param {object} files the config's settings.files
 * @param {object} context .cache & .logger
 * @returns {object} .folders & .files, each a list of { fields, parentPath },
 * & .errors, a list of what couldn't be read - anything in a folder listed
 * there may be missing from the results
 */
export async function scan(files, { cache = new MetadataCache(), logger = silentLogger } = {}) {
	const { rootPath = '', dirs, rules, mediaMetadata, limitToFirstFile, concurrency } = files

	// limits every file operation in the scan, not per folder
	const queue = new PQueue({ concurrency })

	const result = { folders: [], files: [], errors: [] }
	const visited = new Set() // real paths, so symlink loops & overlapping dirs are only walked once

	const baseFields = (fullPath, stat) => ({
		_path: projectPath(fullPath, rootPath),
		_fullPath: fullPath,
		_size: stat.size,
		_sizeText: finderSize(stat.size),
		_ctime: stat.ctime.toISOString(),
		_mtime: stat.mtime.toISOString(),
		_parent: []
	})

	const record = (fullPath, stat, extras = {}) => {
		const fields = baseFields(fullPath, stat)
		for(const key in extras)
			fields['_' + key] = extras[key]
		const isRoot = fields._path == path.posix.sep
		return { fields, parentPath: isRoot ? '' : path.posix.dirname(fields._path) }
	}

	// rules are matched against the path as it's tracked, so they work wherever the folders are
	const allowed = (fullPath, rule) => isAllowed(projectPath(fullPath, rootPath), rule)

	const failed = (fullPath, err) => {
		logger.warn('Failed to read %s', fullPath)
		logger.error('[%s] %s', err.name, err.message)
		result.errors.push(fullPath)
	}

	async function addFile(fullPath, stat) {
		const extras = mediaMetadata ? await media(fullPath, stat) : {}
		result.files.push(record(fullPath, stat, extras))
	}

	async function media(fullPath, stat) {
		const mtime = stat.mtime.toISOString()
		const cached = cache.get(fullPath, stat.size, mtime)
		if(cached) {
			logger.silly('Retrieved cached metadata for %s', fullPath)
			return cached
		}

		logger.silly('Fetching metadata for %s', fullPath)
		let values
		try {
			values = mediaValues(await queue.add(() => probeFile(fullPath)))
		}
		catch(err) {
			if(err.killed || err.code === 'ENOENT') {
				// it timed out, or ffprobe wouldn't run, so that says nothing about the file
				logger.warn('Issue getting metadata for %s', fullPath)
				logger.error('[%s] %s', err.name, err.message)
				return mediaValues()
			}
			logger.verbose('Not a media file: %s', fullPath)
			values = mediaValues()
		}
		cache.set(fullPath, stat.size, mtime, values)
		return values
	}

	const isBrokenLink = fullPath => queue.add(() => fs.lstat(fullPath))
		.then(stat => stat.isSymbolicLink(), () => false)

	// only folders inside the ones being tracked are skipped: skipping one of those would
	// make everything in it look deleted, with nothing in the errors to stop that
	const skipped = dir => !dirs.includes(dir) && (rules.dirs.skip ?? []).some(rule => rule.test(projectPath(dir, rootPath)))

	async function walk(dir) {
		if(skipped(dir)) {
			logger.silly('Skipping %s', dir)
			return
		}

		let stat, names
		try {
			const realPath = await queue.add(() => fs.realpath(dir))
			if(visited.has(realPath))
				return
			visited.add(realPath)

			stat = await queue.add(() => fs.stat(dir))
			names = (await queue.add(() => fs.readdir(dir))).sort(compareNames)
		}
		catch(err) {
			// folders the user has ruled out can't hold anything that matters, like .Trashes
			if(allowed(dir, { includes: [], excludes: rules.dirs.excludes }))
				failed(dir, err)
			return
		}

		logger.silly('Finding files in %s', dir)

		if(allowed(dir, rules.dirs))
			result.folders.push(record(dir, stat, { items: names.length }))

		const entries = await Promise.all(names.map(async name => {
			const fullPath = path.join(dir, name)
			try {
				return { fullPath, stat: await queue.add(() => fs.stat(fullPath)) }
			}
			catch(err) {
				if(await isBrokenLink(fullPath))
					logger.verbose('Skipping broken link %s', fullPath)
				else
					failed(fullPath, err)
			}
		}))

		const found = entries.filter(entry => entry)
		let allowedFiles = found.filter(entry => !entry.stat.isDirectory() && allowed(entry.fullPath, rules.files))
		if(limitToFirstFile)
			allowedFiles = allowedFiles.slice(0, 1)

		await Promise.all([
			...allowedFiles.map(entry => addFile(entry.fullPath, entry.stat)),
			...found.filter(entry => entry.stat.isDirectory()).map(entry => walk(entry.fullPath))
		])
	}

	await Promise.all(dirs.map(walk))

	const byPath = (a, b) => compareNames(a.fields._path, b.fields._path)
	result.folders.sort(byPath)
	result.files.sort(byPath)

	return result
}
