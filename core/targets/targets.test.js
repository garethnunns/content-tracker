import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AirtableTarget } from './airtable.js'
import { GoogleSheetsTarget } from './google-sheets.js'
import { folderFields, mediaFileFields } from '../schema.js'
import { FakeSheets } from '../../e2e/fake-google.mjs'

const settings = { token: 'secret', base: 'appBase', foldersTable: 'Folders', filesTable: 'Files', view: '' }
const wait = () => Promise.resolve()

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })

function airtable(handler, extras = {}) {
	const calls = []
	const http = vi.fn(async (url, options) => {
		const { pathname, search } = new URL(url)
		const body = options.body && JSON.parse(options.body)
		const call = { method: options.method, path: pathname.replace('/v0', ''), search, body, headers: options.headers }
		calls.push(call)
		return handler(call)
	})
	const target = new AirtableTarget({ ...settings, ...extras }, { mediaMetadata: true, http, wait, env: {} })
	return { target, calls }
}

const fullTable = (id, name, fields, views = []) => ({
	id, name, views,
	fields: fields.map(({ name }) => ({ name }))
})

describe('airtable', () => {
	it('needs a token', () => {
		expect(() => new AirtableTarget({ ...settings, token: '' }, { env: {} })).toThrow('Not signed in to Airtable')
	})

	it('prefers the token from the environment', async () => {
		const http = vi.fn(async () => json({ records: [] }))
		const target = new AirtableTarget(settings, { http, wait, env: { AIRTABLE_API_KEY: 'from env' } })
		await target.fetch('folders')
		expect(http.mock.calls[0][1].headers.Authorization).toBe('Bearer from env')
	})

	it('creates both tables with their fields, then the links', async () => {
		const { target, calls } = airtable(({ method, path, body }) => {
			if(method == 'GET')
				return json({ tables: [] })
			if(path.endsWith('/tables'))
				return json({ ...body, id: body.name == 'Folders' ? 'tblF' : 'tblA', fields: body.fields, views: [] })
			return json({ id: 'fld', ...body })
		})

		await target.prepare()

		const creates = calls.filter(call => call.method == 'POST' && call.path.endsWith('/tables'))
		expect(creates.map(call => call.body.name)).toEqual(['Folders', 'Files'])
		expect(creates[0].body.description).toContain('don\'t change the _ fields')
		expect(creates[0].body.fields[0]).toEqual({ name: '_path', type: 'singleLineText' })
		expect(creates[0].body.fields.map(field => field.name)).not.toContain('_parent')
		expect(creates[1].body.fields).toHaveLength(mediaFileFields.length - 1)

		const links = calls.filter(call => call.body?.type == 'multipleRecordLinks')
		expect(links.map(call => call.path)).toEqual([
			'/meta/bases/appBase/tables/tblF/fields',
			'/meta/bases/appBase/tables/tblA/fields'
		])
		expect(links.every(call => call.body.options.linkedTableId == 'tblF')).toBe(true)
	})

	it('makes only the files table, with no link, when folders aren\'t tracked', async () => {
		const calls = []
		const http = vi.fn(async (url, options) => {
			const body = options.body && JSON.parse(options.body)
			calls.push({ method: options.method, body })
			if(options.method == 'GET')
				return json({ tables: [] })
			return json({ ...body, id: 'tblA', fields: body.fields, views: [] })
		})
		const target = new AirtableTarget(settings, { mediaMetadata: false, trackFolders: false, http, wait, env: {} })
		await target.prepare()
		const posts = calls.filter(call => call.method == 'POST')
		expect(posts.map(call => call.body.name)).toEqual(['Files'])
		expect(posts[0].body.fields.map(field => field.name)).not.toContain('_parent')
	})

	it('adds only the fields a table is missing', async () => {
		const { target, calls } = airtable(({ method, body }) => {
			if(method == 'GET')
				return json({ tables: [
					fullTable('tblF', 'Folders', folderFields),
					fullTable('tblA', 'Files', mediaFileFields.filter(field => field.name != '_duration'))
				] })
			return json({ id: 'fld', ...body })
		})

		await target.prepare()

		expect(calls.filter(call => call.method == 'POST')).toMatchObject([
			{ path: '/meta/bases/appBase/tables/tblA/fields', body: { name: '_duration', type: 'number', options: { precision: 2 } } }
		])
	})

	it('changes nothing on a dry run and treats a missing table as empty', async () => {
		const { target, calls } = airtable(() => json({ tables: [] }))
		await target.prepare({ dryRun: true })
		expect(await target.fetch('files')).toEqual([])
		expect(calls.filter(call => call.method != 'GET')).toEqual([])
	})

	it('carries on with an older token that has no schema permissions', async () => {
		const { target } = airtable(({ path }) => {
			if(path.startsWith('/meta'))
				return json({ error: { type: 'INVALID_PERMISSIONS' } }, 403)
			return json({ records: [{ id: 'rec1', fields: { _path: '/a' } }] })
		})

		await target.prepare()
		expect((await target.fetch('folders'))[0].fields).toMatchObject({ _path: '/a', _size: 0, _parent: [] })
	})

	it('can not create a table it only has the ID of', async () => {
		const { target } = airtable(() => json({ tables: [] }), { foldersTable: 'tblIKur1WH3tKxCoI' })
		await expect(target.prepare()).rejects.toThrow('doesn\'t exist')
	})

	it('stops rather than read the whole of a table without its view', async () => {
		const { target } = airtable(() => json({ tables: [
			fullTable('tblF', 'Folders', folderFields, [{ id: 'viw1', name: 'Grid view' }]),
			fullTable('tblA', 'Files', mediaFileFields)
		] }), { view: 'API' })
		await expect(target.prepare()).rejects.toThrow('no view called API')
	})

	it('reads every page, from the view and only our fields', async () => {
		const { target, calls } = airtable(({ search }) => {
			const offset = new URLSearchParams(search).get('offset')
			return offset
				? json({ records: [{ id: 'rec2', fields: { _path: '/b' } }] })
				: json({ records: [{ id: 'rec1', fields: { _path: '/a' } }], offset: 'next' })
		}, { view: 'API' })

		const records = await target.fetch('folders')

		expect(records.map(record => record.id)).toEqual(['rec1', 'rec2'])
		const query = new URLSearchParams(calls[0].search)
		expect(query.get('view')).toBe('API')
		expect(query.getAll('fields[]')).toContain('_items')
	})

	it('sends changes in tens', async () => {
		const { target, calls } = airtable(() => json({ records: [] }))
		const inserts = Array.from({ length: 23 }, (_, i) => ({ _path: '/' + i }))
		const deletes = Array.from({ length: 11 }, (_, i) => ({ id: 'rec' + i }))

		const done = await target.apply('files', { inserts, updates: [], deletes })

		expect(calls.map(call => call.method)).toEqual(['POST', 'POST', 'POST', 'DELETE', 'DELETE'])
		expect(calls[2].body.records).toHaveLength(3)
		expect(done).toEqual({ inserted: 23, updated: 0, deleted: 11 })
	})

	it('waits and retries when rate limited', async () => {
		let limited = true
		const { target } = airtable(() => {
			if(limited) {
				limited = false
				return json({}, 429, { 'retry-after': '1' })
			}
			return json({ records: [] })
		})
		expect(await target.fetch('files')).toEqual([])
	})

	it('never puts the token in an error', async () => {
		const { target } = airtable(() => json({ error: { message: 'Nope' } }, 422))
		const error = await target.fetch('files').catch(err => err)
		expect(error.message).toBe('Airtable said 422 - Nope')
		expect(error.message).not.toContain('secret')
	})

	it('links with record IDs', () => {
		const { target } = airtable(() => json({}))
		expect(target.parentValue({ id: 'rec1' })).toEqual(['rec1'])
		expect(target.parentValue()).toEqual([])
	})
})

const sheetSettings = { spreadsheetId: 'sheet1', foldersSheet: 'Folders', filesSheet: 'Files' }

function googleSheets(tabs, mediaMetadata = false) {
	const fake = new FakeSheets(tabs)
	const target = new GoogleSheetsTarget(sheetSettings, { mediaMetadata, request: fake.request, wait, env: {} })
	return { fake, target }
}

const header = ['_path', '_fullPath', '_size', '_sizeText', '_ctime', '_mtime', '_parent']
const row = (path, size = 1, extras = []) => [path, '/full' + path, size, `${size} bytes`, 'c', 'm', '/', ...extras]
const fields = (path, size = 1) => ({ _path: path, _fullPath: '/full' + path, _size: size, _sizeText: `${size} bytes`, _ctime: 'c', _mtime: 'm', _parent: '/' })

describe('google sheets', () => {
	it('needs credentials', () => {
		expect(() => new GoogleSheetsTarget(sheetSettings, { env: {} })).toThrow('Not signed in to Google')
	})

	it('says when the key is the wrong kind', async () => {
		const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-')), 'key.json')
		await fs.writeFile(file, JSON.stringify({ installed: { client_id: 'an oauth client' } }))
		const target = new GoogleSheetsTarget({ ...sheetSettings, credentials: file }, { wait, env: {} })
		await expect(target.fetch('files')).rejects.toThrow('isn\'t a service account key')
		await fs.rm(path.dirname(file), { recursive: true })
	})

	it('creates the sheets with their headers', async () => {
		const { fake, target } = googleSheets({})
		await target.prepare()
		expect(fake.rows('Folders')[0]).toEqual(folderFields.map(field => field.name))
		expect(fake.rows('Files')[0]).toEqual(header)
	})

	it('notes on a sheet it made what it is, and leaves the user\'s own sheets alone', async () => {
		const { fake, target } = googleSheets({ Files: [['Notes']] })
		await target.prepare()
		const notes = fake.requests.flatMap(request => request.data?.requests ?? []).filter(request => request.updateCells)
		expect(notes).toHaveLength(1)
		expect(notes[0].updateCells.range.sheetId).toBe(fake.sheets.get('Folders').properties.sheetId)
		expect(notes[0].updateCells.rows[0].values[0].note).toContain('don\'t change the _ fields')
	})

	it('shows true and false as tick boxes, only on the rows it has written', async () => {
		const fake = new FakeSheets({})
		const target = new GoogleSheetsTarget(sheetSettings, { mediaMetadata: true, request: fake.request, wait, env: {} })
		const ticks = () => fake.requests.flatMap(request => request.data?.requests ?? []).filter(request => request.setDataValidation)

		// none on an empty sheet, as Sheets would count each empty row with one as part of the table
		await target.prepare()
		expect(ticks()).toEqual([])

		await target.apply('files', { inserts: [{ _path: '/a.mov' }, { _path: '/b.mov' }], updates: [], deletes: [] })
		const headers = fake.rows('Files')[0]
		expect(ticks().map(({ setDataValidation }) => headers[setDataValidation.range.startColumnIndex]))
			.toEqual(['_video', '_videoStill', '_videoAlpha', '_framesExact', '_audio'])
		expect(ticks()[0].setDataValidation).toMatchObject({ range: { startRowIndex: 1, endRowIndex: 3 }, rule: { condition: { type: 'BOOLEAN' } } })

		// one gone and two more makes three records, in rows 2 to 4
		const [first] = await target.fetch('files')
		await target.apply('files', { inserts: [{ _path: '/c.mov' }, { _path: '/d.mov' }], updates: [], deletes: [first] })
		expect(ticks().at(-1).setDataValidation.range.endRowIndex).toBe(4)

		const before = ticks().length
		await target.apply('files', { inserts: [], updates: [], deletes: [] })
		expect(ticks().length).toBe(before)
	})

	it('freezes the header row and _path on a sheet it made, and only those', async () => {
		const { fake, target } = googleSheets({ Files: [['Notes']] })
		await target.prepare()
		const frozen = fake.requests.flatMap(request => request.data?.requests ?? []).filter(request => request.updateSheetProperties)
		expect(frozen).toHaveLength(1)
		expect(frozen[0].updateSheetProperties).toEqual({
			properties: { sheetId: fake.sheets.get('Folders').properties.sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
			fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount'
		})
		expect(fake.rows('Folders')[0][0]).toBe('_path')
	})

	it('fits the columns of a sheet it made to what it first writes, and never again', async () => {
		const { fake, target } = googleSheets({ Files: [['Notes']] })
		const fits = () => fake.requests.flatMap(request => request.data?.requests ?? []).filter(request => request.autoResizeDimensions)
		await target.prepare()
		expect(fits()).toEqual([])

		await target.apply('files', { inserts: [{ _path: '/a.mov' }], updates: [], deletes: [] })
		await target.apply('folders', { inserts: [{ _path: '/a' }], updates: [], deletes: [] })
		expect(fits()).toEqual([{
			autoResizeDimensions: {
				dimensions: { sheetId: fake.sheets.get('Folders').properties.sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: folderFields.length }
			}
		}])

		// a sheet it made, written to again, keeps the widths it has
		await target.apply('folders', { inserts: [{ _path: '/b' }], updates: [], deletes: [] })
		expect(fits()).toHaveLength(1)
	})

	it('warns whoever edits its own columns on a sheet it made', async () => {
		const { fake, target } = googleSheets({ Files: [['Notes']] })
		await target.prepare()
		const ranges = fake.requests.flatMap(request => request.data?.requests ?? []).filter(request => request.addProtectedRange)
		expect(ranges).toHaveLength(1)
		expect(ranges[0].addProtectedRange.protectedRange).toMatchObject({
			range: { sheetId: fake.sheets.get('Folders').properties.sheetId, startColumnIndex: 0, endColumnIndex: folderFields.length },
			warningOnly: true
		})
	})

	it('adds missing headers after the columns already there', async () => {
		const { fake, target } = googleSheets({ Folders: [['Notes', '_path']], Files: [header] })
		await target.prepare()
		expect(fake.rows('Folders')[0]).toEqual(['Notes', '_path', ...folderFields.slice(1).map(field => field.name)])
		expect(fake.rows('Files')[0]).toEqual(header)
	})

	it('grows the grid when a sheet is too narrow', async () => {
		const { fake, target } = googleSheets({ Folders: [header], Files: [header] })
		fake.sheets.get('Files').properties.gridProperties.columnCount = 6
		const media = new GoogleSheetsTarget(sheetSettings, { mediaMetadata: true, request: fake.request, wait, env: {} })
		await media.prepare()
		await target.prepare()
		expect(fake.sheets.get('Files').properties.gridProperties.columnCount).toBe(mediaFileFields.length)
	})

	it('makes only the files sheet, with no _parent, when folders aren\'t tracked', async () => {
		const fake = new FakeSheets({})
		const target = new GoogleSheetsTarget(sheetSettings, { trackFolders: false, request: fake.request, wait, env: {} })
		await target.prepare()
		expect([...fake.sheets.keys()]).toEqual(['Files'])
		expect(fake.rows('Files')[0]).not.toContain('_parent')
	})

	it('changes nothing on a dry run', async () => {
		const { fake, target } = googleSheets({})
		await target.prepare({ dryRun: true })
		expect(await target.fetch('files')).toEqual([])
		expect(fake.sheets.size).toBe(0)
	})

	it('reads records whichever order the columns are in, with typed values', async () => {
		const { target } = googleSheets({
			Files: [
				['Notes', '_size', '_path', '_duration', '_video', '_audio'],
				['mine', 12, '/a.mov', 1.5, true, 'FALSE'],
				[],
				['just a note']
			]
		}, true)

		const records = await target.fetch('files')

		expect(records).toHaveLength(1)
		expect(records[0].id).toBe(2)
		expect(records[0].fields).toMatchObject({ _size: 12, _path: '/a.mov', _duration: 1.5, _video: true, _audio: false, _videoCodec: '', _parent: '' })
	})

	it('updates only our columns, leaving the user\'s', async () => {
		const { fake, target } = googleSheets({ Files: [[...header, 'Notes'], row('/a', 1, ['mine'])] })
		await target.prepare()
		await target.apply('files', { inserts: [], updates: [{ id: 2, fields: fields('/a', 9) }], deletes: [] })
		expect(fake.rows('Files')[1]).toEqual(row('/a', 9, ['mine']))
	})

	it('follows a row that moved since it was read', async () => {
		const { fake, target } = googleSheets({ Files: [header, row('/a'), row('/b')] })
		await target.prepare()
		const [first] = await target.fetch('files')

		fake.rows('Files').reverse()
		fake.rows('Files').unshift(fake.rows('Files').pop())

		await target.apply('files', { inserts: [], updates: [{ id: first.id, fields: fields('/a', 9) }], deletes: [] })
		expect(fake.rows('Files')[2]).toEqual(row('/a', 9))
		expect(fake.rows('Files')[1]).toEqual(row('/b'))
	})

	it('deletes from the bottom up so the right rows go', async () => {
		const { fake, target } = googleSheets({ Files: [header, row('/a'), row('/b'), row('/c'), row('/d')] })
		await target.prepare()
		const records = await target.fetch('files')

		await target.apply('files', { inserts: [], updates: [], deletes: [records[0], records[2]] })

		expect(fake.rows('Files').map(cells => cells[0])).toEqual(['_path', '/b', '/d'])
	})

	it('adds new rows under the right columns', async () => {
		const { fake, target } = googleSheets({ Files: [['Notes', ...header]] })
		await target.prepare()
		await target.apply('files', { inserts: [fields('/a')], updates: [], deletes: [] })
		expect(fake.rows('Files')[1]).toEqual([null, ...row('/a')])
	})

	it('never lets a file name run as a formula', async () => {
		const { fake, target } = googleSheets({ Files: [header] })
		await target.prepare()
		await target.apply('files', { inserts: [fields('/=IMPORTXML("http://x","//a")')], updates: [], deletes: [] })
		const writes = fake.requests.filter(request => request.method != 'GET' && !request.path.startsWith(':'))
		expect(writes.every(({ search, data }) => search.includes('valueInputOption=RAW') || data.valueInputOption == 'RAW')).toBe(true)
	})

	it('handles sheet names with quotes', async () => {
		const fake = new FakeSheets({ "Bob's Files": [header], Folders: [] })
		const target = new GoogleSheetsTarget({ ...sheetSettings, filesSheet: "Bob's Files" }, { request: fake.request, wait, env: {} })
		await target.prepare()
		expect(await target.fetch('files')).toEqual([])
	})

	it('retries when rate limited but not when refused', async () => {
		const request = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('slow'), { status: 429 }))
			.mockResolvedValueOnce({ data: { values: [header] } })
		const target = new GoogleSheetsTarget(sheetSettings, { request, wait, env: {} })
		expect(await target.fetch('files')).toEqual([])

		const refused = new GoogleSheetsTarget(sheetSettings, {
			request: () => Promise.reject(Object.assign(new Error('no'), { status: 403 })),
			wait,
			env: {}
		})
		await expect(refused.fetch('files')).rejects.toThrow('Google Sheets said 403')
	})

	it('links with the parent\'s path, as rows move', () => {
		const { target } = googleSheets({})
		expect(target.parentValue({ id: 2, fields: { _path: '/a' } })).toBe('/a')
		expect(target.parentValue()).toBe('')
	})
})
