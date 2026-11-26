import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoundTimes, MetadataCache, configProblems, defaultConfig, diffRecords, finderSize, isAllowed, parseRegex, parseRule, prepareConfig, renameOld, repeat, scan, syncOnce, writeTemplate } from './index.js'
import { ffprobePath, mediaValues } from './probe.js'
import { configSchema } from './config-schema.js'
import { projectPath } from './scanner.js'

const rules = (files = {}, dirs = {}) => ({
	dirs: { includes: [], excludes: [], ...dirs },
	files: { includes: [], excludes: [], ...files }
})

const filesConfig = (root, extras = {}) => ({
	rootPath: root,
	dirs: [root],
	frequency: 0,
	rules: rules(),
	mediaMetadata: false,
	limitToFirstFile: false,
	concurrency: 4,
	...extras
})

let root

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-')))
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

describe('config', () => {
	it('moves renamed settings to their new names, for the app', () => {
		const old = { settings: { target: 'airtable', files: { dirs: ['/media'] }, airtable: { api: 'pat', base: 'app1', foldersID: 'tbl1', filesID: 'Files' } } }
		const renamed = renameOld(old)
		expect(renamed.settings.airtable).toEqual({ token: 'pat', base: 'app1', foldersTable: 'tbl1', filesTable: 'Files' })
		expect(configProblems(renamed)).toEqual([])
		expect(old.settings.airtable.api).toBe('pat')
	})

	it('removes and asks first unless told otherwise', () => {
		const config = prepareConfig({ settings: { files: { dirs: ['/media'] }, airtable: { base: 'app1' } } })
		expect(config.settings.removing).toEqual({ enabled: true, confirm: true })
		expect(configProblems({ settings: { files: { dirs: ['/media'] }, airtable: { base: 'app1' }, removing: { enabled: 'no' } } }))
			.toEqual(['settings.removing.enabled must be true or false'])
	})

	it('keeps a new name over an old one left beside it', () => {
		const both = { settings: { files: { dirs: ['/media'] }, airtable: { foldersID: 'old', foldersTable: 'new' } } }
		expect(renameOld(both).settings.airtable).toEqual({ foldersTable: 'new' })
	})

	it('leaves a config with no Airtable settings alone', () => {
		expect(renameOld({ settings: { files: { dirs: ['/media'] } } })).toEqual({ settings: { files: { dirs: ['/media'] } } })
	})

	it('accepts the default once it has somewhere to go', () => {
		const config = defaultConfig('/media')
		config.settings.airtable.base = 'app123'
		expect(configProblems(config)).toEqual([])
		expect(isAllowed('/.DS_Store', prepareConfig(config).settings.files.rules.files)).toBe(false)
	})

	it('treats a config from before there was a target as airtable', () => {
		const config = defaultConfig('/media')
		delete config.settings.target
		delete config.settings.files.rootPath
		config.settings.airtable.base = 'app123'
		const { settings } = prepareConfig(config)
		expect(settings.target).toBe('airtable')
		expect(settings.files.rootPath).toBe('')
	})

	it('lists everything wrong at once', () => {
		const config = defaultConfig('/media')
		config.settings.target = 'googleSheets'
		config.settings.files.concurrency = 0
		config.settings.files.rules.files.includes = ['/not a regex']
		const problems = configProblems(config)
		expect(problems).toHaveLength(3)
		expect(() => prepareConfig(config)).toThrow('spreadsheetId')
	})

	it('needs only the folders and where they go, filling in the rest', () => {
		const config = { settings: { files: { dirs: ['/media'] }, airtable: { base: 'app123' } } }
		expect(configProblems(config)).toEqual([])
		const { settings } = prepareConfig(config)
		expect(settings.files).toMatchObject({ rootPath: '', frequency: 30, mediaMetadata: true, limitToFirstFile: false, concurrency: 10 })
		expect(settings.files.rules.dirs).toEqual({ includes: [], excludes: [] })
		expect(isAllowed('/shots/.DS_Store', settings.files.rules.files)).toBe(false)
		expect(settings.airtable).toMatchObject({ token: '', foldersTable: 'Folders', filesTable: 'Files', view: '' })
	})

	it('refuses settings it does not know, rather than quietly ignoring a typo', () => {
		const config = defaultConfig('/media')
		config.settings.airtable.base = 'app123'
		config.settings.files.rootpath = '/media'
		config.settings.files.colour = 'blue'
		config.premiere = {}
		expect(configProblems(config)).toEqual([
			'settings.files.rootpath isn\'t a setting - did you mean rootPath?',
			'settings.files.colour isn\'t a setting',
			'premiere isn\'t a setting'
		])
	})

	it('says what a renamed setting is now called', () => {
		const config = { settings: { files: { dirs: ['/media'] }, airtable: { base: 'app123', api: 'pat', foldersID: 'F', filesID: 'G' } } }
		expect(configProblems(config)).toEqual([
			'settings.airtable.api is now token',
			'settings.airtable.foldersID is now foldersTable',
			'settings.airtable.filesID is now filesTable'
		])
	})

	it('points the template at the schema, which is up to date', async () => {
		expect(defaultConfig('/media').$schema).toMatch(/config\.schema\.json$/)
		const written = JSON.parse(await fs.readFile(new URL('./config.schema.json', import.meta.url), 'utf8'))
		expect(written, 'run npm run schema').toEqual(configSchema)
	})

	it('does not mind nothing being there', () => {
		expect(configProblems({})).toEqual(['settings is missing'])
		expect(configProblems(null)).toEqual(['settings is missing'])
	})

	it('never overwrites a config when making the template', async () => {
		const file = path.join(root, 'config.json')
		await fs.writeFile(file, 'my token')
		expect(await writeTemplate(file, root)).toBe(false)
		expect(await fs.readFile(file, 'utf8')).toBe('my token')
	})

	it('makes the template private to the user', async () => {
		const file = path.join(root, 'config.json')
		expect(await writeTemplate(file, root)).toBe(true)
		if(process.platform != 'win32')
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
	})

	it('drops the flags that make a regex stateful', () => {
		const pattern = parseRegex('/\\.mov$/gi')
		expect(pattern.flags).toBe('i')
		expect([pattern.test('a.mov'), pattern.test('a.mov')]).toEqual([true, true])
	})

	it('explains a bad regex', () => {
		expect(() => parseRegex('/(/')).toThrow('isn\'t valid')
		expect(() => parseRule(5)).toThrow('should be a glob')
	})
})

describe('rules', () => {
	const rules = (includes = [], excludes = []) => ({ includes: includes.map(parseRule), excludes: excludes.map(parseRule) })

	it('allows everything without rules', () => {
		expect(isAllowed('/a.mov', rules())).toBe(true)
	})

	it('needs a match when there are includes, and excludes win', () => {
		const rule = rules(['*.mov'], ['*draft*'])
		expect(isAllowed('/a.mov', rule)).toBe(true)
		expect(isAllowed('/a.tif', rule)).toBe(false)
		expect(isAllowed('/draft.mov', rule)).toBe(false)
	})

	it('matches a glob without a / anywhere, as a .gitignore does', () => {
		const rule = rules([], ['.DS_Store', '._*'])
		expect(isAllowed('/.DS_Store', rule)).toBe(false)
		expect(isAllowed('/shots/.DS_Store', rule)).toBe(false)
		expect(isAllowed('/shots/._a.mov', rule)).toBe(false)
		expect(isAllowed('/shots/a.mov', rule)).toBe(true)
	})

	it('matches a glob with a / from the top', () => {
		const top = rules(['05 Delivery/**'])
		expect(isAllowed('/05 Delivery/a.tif', top)).toBe(true)
		expect(isAllowed('/show/05 Delivery/a.tif', top)).toBe(false)

		const anywhere = rules(['**/05 Delivery/**'])
		expect(isAllowed('/05 Delivery', anywhere)).toBe(true)
		expect(isAllowed('/show/05 Delivery/a.tif', anywhere)).toBe(true)
		expect(isAllowed('/show/05 Delivery Old/a.tif', anywhere)).toBe(false)
	})

	it('still takes a regex, without its slashes escaped', () => {
		const rule = rules(['//05 Delivery//', '/[_.]v\\d{2,3}\\.tif$/i'])
		expect(isAllowed('/show/05 Delivery/a.mov', rule)).toBe(true)
		expect(isAllowed('/show/shot_v012.TIF', rule)).toBe(true)
		expect(isAllowed('/show/shot.tif', rule)).toBe(false)
	})

	it('explains a rule that is neither', () => {
		expect(() => parseRule('/shots/*.tif')).toThrow('for a glob, leave off the first /')
		expect(() => parseRule('')).toThrow('should be a glob')
	})
})

describe('project paths', () => {
	const native = text => text.replaceAll('/', path.sep)

	it('removes the root', () => {
		expect(projectPath(native('/show/a/b.mov'), native('/show'))).toBe('/a/b.mov')
		expect(projectPath(native('/show/a/b.mov'), native('/show/'))).toBe('a/b.mov')
	})

	it('only removes whole folder names', () => {
		expect(projectPath(native('/show-2/a.mov'), native('/show'))).toBe('/show-2/a.mov')
	})

	it('calls the root itself /', () => {
		expect(projectPath(native('/show'), native('/show'))).toBe('/')
	})

	it('keeps the full path with no root', () => {
		expect(projectPath(native('/show/a.mov'), '')).toBe('/show/a.mov')
	})
})

describe('media values', () => {
	it('does not mistake gray for alpha', () => {
		const alpha = pix_fmt => mediaValues({ streams: [{ codec_type: 'video', pix_fmt }] }).videoAlpha
		expect(alpha('gray')).toBe(false)
		expect(alpha('yuv420p')).toBe(false)
		expect(alpha('bayer_rggb8')).toBe(false)
		expect(alpha('yuva444p10le')).toBe(true)
		expect(alpha('rgba')).toBe(true)
		expect(alpha('ya8')).toBe(true)
		expect(alpha('gbrap12le')).toBe(true)
	})

	it('finds the ffprobe npm installed for this computer, and says when there isn\'t one', async () => {
		const found = ffprobePath()
		expect(found).toContain(`@generativenoise${path.sep}ffprobe-${process.platform}-${process.arch}`)
		await expect(fs.access(found)).resolves.toBeUndefined()
		expect(() => ffprobePath('plan9', 'x64')).toThrow('There\'s no ffprobe for plan9-x64')
	})

	it('copes with what ffprobe leaves out', () => {
		const values = mediaValues({ streams: [{ codec_type: 'video', r_frame_rate: '0/0', bit_rate: 'N/A' }], format: { duration: 'N/A' } })
		expect(values).toMatchObject({ video: true, videoFormat: '', videoAlpha: false, videoFPS: 0, videoBitRate: 0, duration: 0 })
	})

	it('has nothing for what is not media', () => {
		expect(mediaValues()).toMatchObject({ video: false, audio: false, duration: 0 })
	})

	it('gives stills no duration or frame rate', () => {
		const values = mediaValues({
			streams: [{ codec_type: 'video', r_frame_rate: '25/1' }],
			format: { format_long_name: 'piped png sequence', duration: '0.04' }
		})
		expect(values).toMatchObject({ videoStill: true, duration: 0, videoFPS: 0 })
	})

	describe('frames', () => {
		const frames = (stream, format = {}) => {
			const { frames, framesExact } = mediaValues({ streams: [{ codec_type: 'video', ...stream }], format })
			return { frames, framesExact }
		}

		it('counts them from nb_frames when ffprobe has it', () => {
			expect(frames({ nb_frames: '35964', r_frame_rate: '60000/1001', duration: '600.0' }))
				.toEqual({ frames: 35964, framesExact: true })
		})

		it('works them out from the video\'s length when it hasn\'t', () => {
			// an H.264 .mp4 leaves nb_frames out
			expect(frames({ r_frame_rate: '30/1', duration: '60.0' }))
				.toEqual({ frames: 1800, framesExact: false })
		})

		it('uses the video\'s length over the file\'s, which a longer audio track stretches', () => {
			expect(frames({ r_frame_rate: '60000/1001', duration: '600.0' }, { duration: '600.07' }))
				.toEqual({ frames: 35964, framesExact: false })
		})

		it('reads the video\'s length from its tag in a .mkv, which has no duration of its own', () => {
			// from a 10 second clip with 11 seconds of audio: the file's length made it 661
			expect(frames({ r_frame_rate: '60000/1001', tags: { DURATION: '00:00:09.994000000' } }, { duration: '11.023' }))
				.toEqual({ frames: 599, framesExact: false })
		})

		it('falls back to the file\'s length when the video hasn\'t got one', () => {
			expect(frames({ r_frame_rate: '25/1' }, { duration: '4.0' }))
				.toEqual({ frames: 100, framesExact: false })
		})

		it('makes an image one frame, so a sequence adds up to its length', () => {
			expect(frames({ r_frame_rate: '25/1' }, { format_long_name: 'piped tiff sequence' }))
				.toEqual({ frames: 1, framesExact: true })
		})

		it('has none without video', () => {
			expect(mediaValues({ streams: [{ codec_type: 'audio' }], format: { duration: '3' } }))
				.toMatchObject({ frames: 0, framesExact: false })
			expect(frames({ r_frame_rate: '0/0', nb_frames: 'N/A' }, { duration: 'N/A' }))
				.toEqual({ frames: 0, framesExact: false })
		})
	})
})

describe('scan', () => {
	it('finds folders & files, with their parents', async () => {
		await fs.mkdir(path.join(root, 'a/b'), { recursive: true })
		await fs.writeFile(path.join(root, 'a/b/c.txt'), 'hello')

		const found = await scan(filesConfig(root))

		expect(found.errors).toEqual([])
		expect(found.folders.map(folder => folder.fields._path)).toEqual(['/', '/a', '/a/b'])
		expect(found.folders[1].fields._items).toBe(1)
		expect(found.folders[1].parentPath).toBe('/')
		expect(found.files[0].fields).toMatchObject({ _path: '/a/b/c.txt', _size: 5 })
		expect(found.files[0].parentPath).toBe('/a/b')
	})

	it('limits to the first allowed file of each folder', async () => {
		await fs.mkdir(path.join(root, 'a.b'))
		for(const name of ['2.tif', '1.tif', '0.txt'])
			await fs.writeFile(path.join(root, name), '')

		const found = await scan(filesConfig(root, {
			rules: rules({ includes: [/\.tif$/] }),
			limitToFirstFile: true
		}))

		expect(found.files.map(file => file.fields._path)).toEqual(['/1.tif'])
	})

	it('still looks in folders the rules leave out', async () => {
		await fs.mkdir(path.join(root, 'skip/keep'), { recursive: true })
		const found = await scan(filesConfig(root, { rules: rules({}, { includes: [/keep/] }) }))
		expect(found.folders.map(folder => folder.fields._path)).toEqual(['/skip/keep'])
	})

	it('matches rules against the path as it is tracked, wherever the folders are', async () => {
		await fs.mkdir(path.join(root, 'shots'))
		await fs.writeFile(path.join(root, 'shots/a.tif'), '')
		await fs.writeFile(path.join(root, 'b.tif'), '')
		const top = rules({}, { includes: ['shots/*.tif', '/^\\/b/'].map(parseRule) })
		const found = await scan(filesConfig(root, { rules: top }))
		expect(found.files.map(file => file.fields._path)).toEqual(['/b.tif', '/shots/a.tif'])
	})

	it('reports a folder that is not there rather than finding it empty', async () => {
		const found = await scan(filesConfig(root, { dirs: [path.join(root, 'nope')] }))
		expect(found.errors).toEqual([path.join(root, 'nope')])
	})

	it('survives a symlink loop', async () => {
		await fs.mkdir(path.join(root, 'a'))
		await fs.symlink(root, path.join(root, 'a/loop'), 'dir')
		const found = await scan(filesConfig(root))
		expect(found.folders.map(folder => folder.fields._path)).toEqual(['/', '/a'])
	})

	it('skips a broken link rather than call the scan failed', async () => {
		await fs.symlink(path.join(root, 'nothing'), path.join(root, 'broken'))
		const found = await scan(filesConfig(root))
		expect(found.errors).toEqual([])
		expect(found.files).toEqual([])
	})

	it.skipIf(process.platform == 'win32' || process.getuid?.() === 0)('reports folders it can not read, unless they are ruled out', async () => {
		const locked = path.join(root, '.Trashes')
		await fs.mkdir(locked, { mode: 0o000 })

		expect((await scan(filesConfig(root))).errors).toEqual([locked])

		const ruledOut = rules({}, { excludes: [/\.Trashes/] })
		expect((await scan(filesConfig(root, { rules: ruledOut }))).errors).toEqual([])

		await fs.chmod(locked, 0o700)
	})

	it('only walks overlapping folders once', async () => {
		await fs.mkdir(path.join(root, 'a'))
		const found = await scan(filesConfig(root, { dirs: [root, path.join(root, 'a')] }))
		expect(found.folders).toHaveLength(2)
	})

	it('only probes files that have changed', async () => {
		const file = path.join(root, 'notes.txt')
		await fs.writeFile(file, 'hello')
		const cache = new MetadataCache()
		const get = vi.spyOn(cache, 'get')
		const set = vi.spyOn(cache, 'set')

		const config = filesConfig(root, { mediaMetadata: true })
		await scan(config, { cache })
		await scan(config, { cache })

		expect(get).toHaveBeenCalledTimes(2)
		expect(set).toHaveBeenCalledTimes(1)
	})

	it('reads a file again when its cached details are missing a field', async () => {
		const file = path.join(root, 'notes.txt')
		await fs.writeFile(file, 'hello')
		const stat = await fs.stat(file)
		const cache = new MetadataCache()
		// as a version from before frames were counted would have left it
		const { frames, framesExact, ...older } = mediaValues()
		cache.set(file, stat.size, stat.mtime.toISOString(), older)
		const set = vi.spyOn(cache, 'set')

		const found = await scan(filesConfig(root, { mediaMetadata: true }), { cache })

		expect(set).toHaveBeenCalledTimes(1)
		expect(found.files[0].fields).toMatchObject({ _frames: frames, _framesExact: framesExact })
	})
})

describe('cache', () => {
	it('survives being stored and misses when the file changes', async () => {
		const file = path.join(root, 'cache', 'cache.json')
		const cache = new MetadataCache(file)
		cache.set('/a', 1, 'then', { video: true })
		await cache.save()

		const reloaded = new MetadataCache(file)
		await reloaded.load()
		expect(reloaded.get('/a', 1, 'then')).toEqual({ video: true })
		expect(reloaded.get('/a', 2, 'then')).toBeUndefined()
	})

	it('forgets files that have gone', async () => {
		const file = path.join(root, 'cache.json')
		const cache = new MetadataCache(file)
		cache.set('/a', 1, 'then', {})
		await cache.save()
		await cache.save()
		await cache.load()
		expect(cache.get('/a', 1, 'then')).toBeUndefined()
	})

	it('starts afresh from a corrupted file', async () => {
		const file = path.join(root, 'cache.json')
		await fs.writeFile(file, '{nope')
		const cache = new MetadataCache(file)
		await cache.load()
		expect(cache.get('/a', 1, 'then')).toBeUndefined()
	})
})

describe('diff', () => {
	const local = (path, extras = {}) => ({ fields: { _path: path, _size: 1, ...extras }, parentPath: '/' })
	const remote = (id, path, extras = {}) => ({ id, fields: { _path: path, _size: 1, _parent: [], ...extras } })
	const noParent = () => []

	it('splits into inserts, updates & deletes', () => {
		const diffs = diffRecords(
			[local('/same'), local('/changed', { _size: 2 }), local('/new')],
			[remote('a', '/same'), remote('b', '/changed'), remote('c', '/gone')],
			noParent
		)
		expect(diffs.inserts.map(fields => fields._path)).toEqual(['/new'])
		expect(diffs.updates).toMatchObject([{ id: 'b', fields: { _size: 2 } }])
		expect(diffs.deletes.map(record => record.id)).toEqual(['c'])
	})

	it('ignores columns the user has added', () => {
		const diffs = diffRecords([local('/a')], [remote('a', '/a', { Notes: 'mine' })], noParent)
		expect(diffs.updates).toEqual([])
	})

	it('removes duplicates', () => {
		const diffs = diffRecords([local('/a')], [remote('a', '/a'), remote('b', '/a')], noParent)
		expect(diffs.deletes.map(record => record.id)).toEqual(['b'])
	})

	it('updates when the parent changes', () => {
		const diffs = diffRecords([local('/a')], [remote('a', '/a')], () => ['rec1'])
		expect(diffs.updates[0].fields._parent).toEqual(['rec1'])
	})
})

describe('sync', () => {
	class MemoryTarget {
		tables = { folders: [], files: [] }
		nextId = 1
		prepare = vi.fn()

		fetch(table) {
			return this.tables[table].map(record => structuredClone(record))
		}

		apply(table, diffs) {
			const rows = this.tables[table]
			diffs.inserts.forEach(fields => rows.push({ id: 'rec' + this.nextId++, fields }))
			diffs.updates.forEach(({ id, fields }) => rows.find(row => row.id == id).fields = fields)
			const gone = new Set(diffs.deletes.map(record => record.id))
			this.tables[table] = rows.filter(row => !gone.has(row.id))
			return { inserted: diffs.inserts.length, updated: diffs.updates.length, deleted: gone.size }
		}

		parentValue(folder) {
			return folder ? [folder.id] : []
		}
	}

	const config = extras => ({ settings: { files: filesConfig(root, extras) } })
	const cache = () => new MetadataCache()

	beforeEach(async () => {
		await fs.mkdir(path.join(root, 'a'))
		await fs.writeFile(path.join(root, 'a/one.txt'), '1')
	})

	it('links everything in a single run', async () => {
		const target = new MemoryTarget()
		const summary = await syncOnce(config(), target, { cache: cache() })

		const [top, folder] = target.tables.folders
		expect(folder.fields._parent).toEqual([top.id])
		expect(target.tables.files[0].fields._parent).toEqual([folder.id])
		expect(summary.folders.inserted).toBe(2)
		expect(summary.folders.updated).toBe(1)
		expect(summary.files.inserted).toBe(1)
	})

	it('has nothing to do the second time', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		const summary = await syncOnce(config(), target, { cache: cache() })
		expect(summary.folders).toEqual({ inserted: 0, updated: 0, deleted: 0 })
		expect(summary.files).toEqual({ inserted: 0, updated: 0, deleted: 0 })
	})

	it('changes nothing on a dry run', async () => {
		const target = new MemoryTarget()
		const summary = await syncOnce(config(), target, { cache: cache(), dryRun: true })
		expect(target.tables.files).toEqual([])
		expect(target.prepare).toHaveBeenCalledWith({ dryRun: true })
		expect(summary.files.inserted).toBe(1)
	})

	it('removes what has gone', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.rm(path.join(root, 'a/one.txt'))
		await syncOnce(config(), target, { cache: cache() })
		expect(target.tables.files).toEqual([])
	})

	it('removes nothing when told not to', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.rm(path.join(root, 'a/one.txt'))
		await syncOnce(config(), target, { cache: cache(), allowDeletes: false })
		expect(target.tables.files).toHaveLength(1)
	})

	it('removes nothing when part of the scan failed', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })

		// one of the drives has gone away
		await fs.rm(path.join(root, 'a/one.txt'))
		const dirs = [root, path.join(root, 'unmounted')]
		const summary = await syncOnce(config({ dirs }), target, { cache: cache() })

		expect(summary.unreadable).toHaveLength(1)
		expect(target.tables.files).toHaveLength(1)
	})

	it('lists what it tracked, and what it would do to each on a dry run', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.writeFile(path.join(root, 'a/one.txt'), 'changed')
		await fs.writeFile(path.join(root, 'a/two.txt'), '2')
		await fs.mkdir(path.join(root, 'b'))
		target.tables.files.push({ id: 'gone', fields: { _path: '/a/gone.txt' } })

		const { items } = await syncOnce(config(), target, { cache: cache(), dryRun: true })

		expect(items.files.map(({ path, status }) => ({ path, status }))).toEqual([
			{ path: '/a/gone.txt', status: 'deleted' },
			{ path: '/a/one.txt', status: 'modified' },
			{ path: '/a/two.txt', status: 'new' }
		])
		expect(items.files[1]).toMatchObject({ size: 7, modified: expect.stringMatching(/^\d{4}-/) })
		expect(items.folders.find(item => item.path == '/b').status).toBe('new')
	})

	it('remembers when each was first found, and forgets what has gone', async () => {
		const target = new MemoryTarget()
		const found = new FoundTimes()
		const first = await syncOnce(config(), target, { cache: cache(), found })
		const when = first.items.files[0].found
		expect(Date.parse(when)).toBeGreaterThan(0)

		await new Promise(resolve => setTimeout(resolve, 5))
		await fs.writeFile(path.join(root, 'a/two.txt'), '2')
		const second = await syncOnce(config(), target, { cache: cache(), found })
		expect(second.items.files.find(item => item.path == '/a/one.txt').found).toBe(when)
		expect(second.items.files.find(item => item.path == '/a/two.txt').found > when).toBe(true)

		await fs.rm(path.join(root, 'a/one.txt'))
		await syncOnce(config(), target, { cache: cache(), found })
		expect(found.get('files:/a/one.txt')).toBeUndefined()
	})

	it('keeps when things were found through a run that could not read everything', async () => {
		const target = new MemoryTarget()
		const found = new FoundTimes()
		await syncOnce(config(), target, { cache: cache(), found })
		const unmounted = { ...config(), settings: { ...config().settings, files: { ...config().settings.files, dirs: [path.join(root, 'gone')] } } }
		await syncOnce(unmounted, target, { cache: cache(), found })
		expect(found.get('files:/a/one.txt')).toBeDefined()
	})

	it('tracks only the files when told to, without touching folders', async () => {
		const target = new MemoryTarget()
		const fetch = vi.spyOn(target, 'fetch')
		const filesOnly = { ...config(), settings: { ...config().settings, files: { ...config().settings.files, trackFolders: false } } }

		const summary = await syncOnce(filesOnly, target, { cache: cache() })

		expect(target.tables.folders).toEqual([])
		expect(fetch.mock.calls.map(call => call[0])).toEqual(['files'])
		expect(target.tables.files[0].fields).not.toHaveProperty('_parent')
		expect(summary.found.folders).toBe(0)
		expect(summary.items.folders).toEqual([])
	})

	it('removes nothing when the config says not to', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.rm(path.join(root, 'a/one.txt'))
		const keeping = { ...config(), settings: { ...config().settings, removing: { enabled: false, confirm: true } } }
		await syncOnce(keeping, target, { cache: cache() })
		expect(target.tables.files).toHaveLength(1)
	})

	it('removes a lot without asking when the config says so', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.rm(path.join(root, 'a/one.txt'))
		const confirmDeletes = vi.fn().mockResolvedValue(false)
		const trusting = { ...config(), settings: { ...config().settings, removing: { enabled: true, confirm: false } } }
		await syncOnce(trusting, target, { cache: cache(), confirmDeletes })
		expect(confirmDeletes).not.toHaveBeenCalled()
		expect(target.tables.files).toHaveLength(0)
	})

	it('asks before removing a lot, and listens', async () => {
		const target = new MemoryTarget()
		await syncOnce(config(), target, { cache: cache() })
		await fs.rm(path.join(root, 'a/one.txt'))

		const confirmDeletes = vi.fn().mockResolvedValue(false)
		await syncOnce(config(), target, { cache: cache(), confirmDeletes })

		expect(confirmDeletes).toHaveBeenCalledWith({ table: 'files', count: 1, total: 1 })
		expect(target.tables.files).toHaveLength(1)
	})
})

describe('repeat', () => {
	it('runs once with no frequency', async () => {
		const run = vi.fn()
		await repeat(run, 0).done
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('reports failures and stops when asked', async () => {
		const onError = vi.fn()
		const looping = repeat(() => { throw new Error('no') }, 60, onError)
		await vi.waitFor(() => expect(onError).toHaveBeenCalled())
		looping.stop()
		await looping.done
		expect(onError).toHaveBeenCalledTimes(1)
	})

	it('says when it will next run, as it waits', async () => {
		const onWait = vi.fn()
		const before = Date.now()
		const looping = repeat(() => {}, 60, undefined, onWait)
		await vi.waitFor(() => expect(onWait).toHaveBeenCalled())
		looping.stop()
		await looping.done
		const until = onWait.mock.calls[0][0]
		expect(until).toBeGreaterThanOrEqual(before + 60000)
		expect(until).toBeLessThanOrEqual(Date.now() + 60000)
	})
})

describe('sizes', () => {
	it('writes them as the Finder does', () => {
		expect(finderSize(0)).toBe('Zero bytes')
		expect(finderSize(1)).toBe('1 byte')
		expect(finderSize(512)).toBe('512 bytes')
		expect(finderSize(36412)).toBe('36 KB')
		expect(finderSize(1200000)).toBe('1.2 MB')
		expect(finderSize(2000000)).toBe('2 MB')
		expect(finderSize(1843200000)).toBe('1.84 GB')
		expect(finderSize(999999)).toBe('1 MB')
		expect(finderSize(5.5e12)).toBe('5.5 TB')
	})
})
