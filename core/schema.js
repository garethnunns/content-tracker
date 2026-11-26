// The columns each table needs. Airtable's and Google Sheets' setup, and the
// defaults for blank values, are all worked out from these lists.

// what a table the tracker makes says of itself: Airtable's description, a sheet's note on its first header
export const TABLE_NOTE = 'Filled in automatically by Content Tracker - don\'t change the _ fields, as they\'re overwritten.'

const defaultsByType = {
	text: '',
	integer: 0,
	decimal: 0,
	checkbox: false,
	dateTime: '',
	link: []
}

const field = (key, type) => ({ key, name: '_' + key, type })

const commonFields = [
	field('path', 'text'),
	field('fullPath', 'text'),
	field('size', 'integer'),
	field('sizeText', 'text'),
	field('ctime', 'dateTime'),
	field('mtime', 'dateTime'),
	field('parent', 'link')
]

export const folderFields = [
	...commonFields,
	field('items', 'integer')
]

export const fileFields = commonFields

export const mediaFileFields = [
	...commonFields,
	field('duration', 'decimal'),
	field('video', 'checkbox'),
	field('videoStill', 'checkbox'),
	field('videoCodec', 'text'),
	field('videoWidth', 'integer'),
	field('videoHeight', 'integer'),
	field('videoFormat', 'text'),
	field('videoAlpha', 'checkbox'),
	field('videoFPS', 'decimal'),
	field('frames', 'integer'),
	field('framesExact', 'checkbox'),
	field('videoBitRate', 'integer'),
	field('audio', 'checkbox'),
	field('audioCodec', 'text'),
	field('audioSampleRate', 'integer'),
	field('audioChannels', 'integer'),
	field('audioBitRate', 'integer')
]

/**
 * The fields of a table
 * @param {string} table 'folders' or 'files'
 * @param {boolean} mediaMetadata whether files carry the media fields
 * @param {boolean} trackFolders whether there's a folders table for files to link to
 * @returns {array} the fields, with the primary one first
 */
export function fieldsFor(table, mediaMetadata, trackFolders = true) {
	if(table == 'folders')
		return folderFields
	const fields = mediaMetadata ? mediaFileFields : fileFields
	// with no folders tracked, there's nothing for a file to link to
	return trackFolders ? fields : fields.filter(field => field.name != '_parent')
}

/**
 * The default value of a field's type
 * @param {object} field one of the fields above
 */
export function defaultValue(field) {
	const value = defaultsByType[field.type]
	return Array.isArray(value) ? [...value] : value
}

/**
 * Default values for a list of fields
 * @param {array} fields
 * @returns {object} keyed by field name
 */
export function defaultsFor(fields) {
	return Object.fromEntries(fields.map(field => [field.name, defaultValue(field)]))
}
