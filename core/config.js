import { promises as fs, statSync } from 'fs'
import picomatch from 'picomatch'
import { configSchema } from './config-schema.js'
import { PACKAGE } from './updates.js'

export const TARGETS = ['airtable', 'googleSheets']

// where editors find the schema, for the template to point them at
export const SCHEMA_URL = `https://unpkg.com/${PACKAGE}/core/config.schema.json`

// what settings were called before, so a config using them says what to change
const RENAMED = {
	'settings.airtable.api': 'token',
	'settings.airtable.foldersID': 'foldersTable',
	'settings.airtable.filesID': 'filesTable'
}

/**
 * A config with the old names of renamed settings changed to their new ones. The
 * command line says what to change instead, as a person is editing the file, but the
 * app keeps its settings itself, so it moves them over without asking
 * @param {object} config as stored
 * @returns {object} a copy
 */
export function renameOld(config) {
	const renamed = structuredClone(config)
	for(const [old, now] of Object.entries(RENAMED)) {
		const path = old.split('.')
		const key = path.pop()
		const parent = path.reduce((value, part) => value?.[part], renamed)
		if(!parent || typeof parent != 'object' || !(key in parent))
			continue
		parent[now] ??= parent[key]
		delete parent[key]
	}
	return renamed
}

/**
 * The config a new user starts from
 * @param {string} folder the folder to track
 * @returns {object} config
 */
export function defaultConfig(folder) {
	return {
		$schema: SCHEMA_URL,
		settings: {
			target: 'airtable',
			files: {
				rootPath: folder,
				dirs: [folder],
				frequency: 30,
				rules: {
					dirs: { includes: [], excludes: [], skip: [] },
					files: { includes: [], excludes: ['.DS_Store'] }
				},
				mediaMetadata: true,
				limitToFirstFile: false,
				concurrency: 10
			},
			airtable: {
				token: '',
				base: '',
				foldersTable: 'Folders',
				filesTable: 'Files',
				view: ''
			},
			googleSheets: {
				spreadsheetId: '',
				credentials: '',
				foldersSheet: 'Folders',
				filesSheet: 'Files'
			}
		}
	}
}

/**
 * Write a config template, leaving alone any config that's already there
 * @param {string} file path of the file to create
 * @param {string} folder the folder to track
 * @returns {boolean} false if there was already a file there
 */
export async function writeTemplate(file, folder) {
	try {
		await fs.writeFile(file, JSON.stringify(defaultConfig(folder), null, 2), { flag: 'wx', mode: 0o600 })
		return true
	}
	catch(err) {
		if(err.code == 'EEXIST')
			return false
		throw err
	}
}

/**
 * Read a config from a file, ready for use
 * @param {string} file path of the config
 * @returns {Promise} config, with its rules compiled
 * @throws if the file can't be read or anything in it is wrong
 */
export async function loadConfig(file) {
	const config = JSON.parse(await fs.readFile(file, 'utf8'))
	return prepareConfig(config)
}

/**
 * Validate a config and compile its rules
 * @param {object} config as stored
 * @returns {object} a copy which the scanner & targets can use
 * @throws {Error} listing everything that's wrong with it
 */
export function prepareConfig(config) {
	const problems = configProblems(config)
	if(problems.length)
		throw new Error('Invalid config:\n- ' + problems.join('\n- '))

	const prepared = withDefaults(config)
	const { settings } = prepared
	settings.googleSheets.spreadsheetId = spreadsheetId(settings.googleSheets.spreadsheetId)
	settings.files.rules = compileRules(settings.files.rules)
	return prepared
}

/**
 * A config with everything left out filled in, from the schema's defaults
 * @param {object} config as stored
 * @returns {object} a copy
 */
export function withDefaults(config) {
	const filled = structuredClone(config)
	fill(filled, configSchema)
	return filled
}

const resolve = node => node.$ref ? configSchema.definitions[node.$ref.split('/').pop()] : node

function fill(value, node) {
	for(const [key, child] of Object.entries(resolve(node).properties ?? {})) {
		const schema = resolve(child)
		if(value[key] === undefined && schema.default !== undefined)
			value[key] = structuredClone(schema.default)
		else if(value[key] === undefined && schema.properties && key != 'settings')
			value[key] = {}

		if(schema.properties && typeof value[key] == 'object' && value[key] !== null && !Array.isArray(value[key]))
			fill(value[key], schema)
	}
}

/**
 * Settings it doesn't know, as a typo would otherwise be quietly ignored
 * @returns {array} a sentence for each
 */
function unknownSettings(value, node, at) {
	const schema = resolve(node)
	if(!schema.properties || typeof value != 'object' || value === null || Array.isArray(value))
		return []

	const known = Object.keys(schema.properties)
	return Object.entries(value).flatMap(([key, child]) => {
		const name = at ? `${at}.${key}` : key
		if(RENAMED[name])
			return [`${name} is now ${RENAMED[name]}`]
		if(!known.includes(key)) {
			const meant = known.find(other => other.toLowerCase() == key.toLowerCase())
			return [`${name} isn't a setting` + (meant ? ` - did you mean ${meant}?` : '')]
		}
		return unknownSettings(child, schema.properties[key], name)
	})
}

/**
 * Everything that's wrong with a config
 * @param {object} config as stored
 * @returns {array} a sentence for each problem, empty if there are none
 */
export function configProblems(config) {
	const settings = config?.settings
	if(typeof settings != 'object' || settings === null)
		return ['settings is missing']

	const problems = unknownSettings(config, configSchema, '')
	const filled = withDefaults(config).settings
	const target = filled.target
	const files = typeof settings.files == 'object' && settings.files !== null ? filled.files : settings.files

	if(!TARGETS.includes(target))
		problems.push(`settings.target must be one of ${TARGETS.join(', ')}`)

	if(typeof files != 'object' || files === null)
		problems.push('settings.files is missing')
	else {
		if(!Array.isArray(files.dirs) || !files.dirs.length || files.dirs.some(dir => typeof dir != 'string' || !dir))
			problems.push('settings.files.dirs needs at least one folder')
		if(files.rootPath !== undefined && typeof files.rootPath != 'string')
			problems.push('settings.files.rootPath must be text')
		if(!(files.frequency >= 0))
			problems.push('settings.files.frequency must be 0 or more')
		if(!(Number.isInteger(files.concurrency) && files.concurrency >= 1))
			problems.push('settings.files.concurrency must be a whole number of 1 or more')
		for(const setting of ['mediaMetadata', 'limitToFirstFile', 'trackFolders'])
			if(typeof files[setting] != 'boolean')
				problems.push(`settings.files.${setting} must be true or false`)

		for(const type of ['dirs', 'files'])
			for(const rule of type == 'dirs' ? ['includes', 'excludes', 'skip'] : ['includes', 'excludes']) {
				const patterns = files.rules?.[type]?.[rule]
				if(!Array.isArray(patterns))
					problems.push(`settings.files.rules.${type}.${rule} must be a list`)
				else
					for(const pattern of patterns)
						try {
							parseRule(pattern)
						}
						catch(err) {
							problems.push(`settings.files.rules.${type}.${rule}: ${err.message}`)
						}
			}
	}

	for(const setting of ['enabled', 'confirm'])
		if(typeof filled.removing?.[setting] != 'boolean')
			problems.push(`settings.removing.${setting} must be true or false`)

	if(target == 'airtable') {
		const airtable = filled.airtable
		if(!airtable.base)
			problems.push('settings.airtable.base is missing')
		if(!airtable.foldersTable)
			problems.push('settings.airtable.foldersTable is missing')
		if(!airtable.filesTable)
			problems.push('settings.airtable.filesTable is missing')
	}

	if(target == 'googleSheets') {
		const sheets = filled.googleSheets
		if(!sheets.spreadsheetId)
			problems.push('settings.googleSheets.spreadsheetId is missing')
		if(!sheets.foldersSheet)
			problems.push('settings.googleSheets.foldersSheet is missing')
		if(!sheets.filesSheet)
			problems.push('settings.googleSheets.filesSheet is missing')
	}

	return problems
}

/**
 * A spreadsheet's ID, from its link or the ID itself
 * @param {string} text e.g. https://docs.google.com/spreadsheets/d/1aBc.../edit
 * @returns {string}
 */
export function spreadsheetId(text = '') {
	return text.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] ?? text.trim()
}

/**
 * Turn a stringified regex from the config back into a RegExp
 * @param {string} pattern e.g. '/\\.mov$/i'
 * @returns {RegExp} without g & y, which would make it remember where it got to
 * @throws {Error} if it isn't a valid regex
 */
export function parseRegex(pattern) {
	const match = typeof pattern == 'string' && pattern.match(/^\/(.*)\/([a-z]*)$/s)
	if(!match)
		throw new Error(`${JSON.stringify(pattern)} starts with /, so it should be a regex like /pattern/ - for a glob, leave off the first /`)

	try {
		return new RegExp(match[1], match[2].replace(/[gy]/g, ''))
	}
	catch(err) {
		throw new Error(`${pattern} isn't valid - ${err.message}`, { cause: err })
	}
}

/**
 * Turn a rule from the config into something that can test a tracked path
 * @param {string} pattern a regex written /like this/, or a glob like *.mov or
 * shots/**, which matches anywhere when it has no / in it, as in a .gitignore
 * @returns {object} .test(path), the path as it's tracked, starting with /
 * @throws {Error} if it isn't a valid rule
 */
export function parseRule(pattern) {
	if(typeof pattern != 'string' || !pattern)
		throw new Error(`${JSON.stringify(pattern)} should be a glob like *.mov, or a regex like /pattern/`)
	if(pattern.startsWith('/'))
		return parseRegex(pattern)

	const glob = picomatch(pattern.includes('/') ? pattern : `**/${pattern}`, { dot: true })
	return { test: tracked => glob(tracked.replace(/^\//, '')) }
}

function compileRules(rules) {
	const compile = ({ includes, excludes }) => ({
		includes: includes.map(parseRule),
		excludes: excludes.map(parseRule)
	})
	return {
		dirs: { ...compile(rules.dirs), skip: (rules.dirs.skip ?? []).map(parseRule) },
		files: compile(rules.files)
	}
}

/**
 * Work out if we're allowed a file based on the rules
 * @param {string} tracked the path as it's tracked, like /shots/a.mov, so the
 * same rules work wherever the folders are, on Mac & Windows
 * @param {object} rules object of arrays .includes & .excludes, from parseRule()
 * @returns {boolean}
 */
export function isAllowed(tracked, rules) {
	const matches = rule => rule.test(tracked)
	const included = !rules.includes.length || rules.includes.some(matches)
	return included && !rules.excludes.some(matches)
}

/**
 * The Airtable token, the environment's first so it needn't be kept in the config
 * @param {object} airtable the config's settings.airtable
 * @returns {string}
 */
export function airtableToken(airtable, env = process.env) {
	return env.AIRTABLE_API_KEY || airtable.token || ''
}

/**
 * Where the Google service account's key is, the environment's first
 * @param {object} sheets the config's settings.googleSheets
 * @returns {string} path, empty if there isn't one
 */
export function googleCredentials(sheets, env = process.env) {
	return env.GOOGLE_APPLICATION_CREDENTIALS || sheets.credentials || ''
}

/**
 * Whether other people on this computer could read a config with a token in it
 * @param {string} file path of the config
 * @param {object} config as stored
 * @returns {boolean}
 */
export function isExposed(file, config) {
	if(process.platform == 'win32' || !config.settings?.airtable?.token)
		return false
	return (statSync(file).mode & 0o077) != 0
}
