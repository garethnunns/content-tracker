<script>
// which steps were open, kept for coming back to the settings while the app's open
let remembered
</script>

<script setup>
import { computed, ref, watch } from 'vue'
import SettingField from './SettingField.vue'
import SettingsStep from './SettingsStep.vue'

const model = defineModel({ type: Object, required: true })

const { tracker } = window

const edited = ref()
const token = ref('')
const problems = ref([])
const saved = ref(false)
const saving = ref(false)
// waiting on the browser: 'signIn' or 'choose', and never so long it can't be asked again
const waiting = ref('')
const busy = ref(false)
// what went wrong signing in, or choosing what to track in, and in which step
const authError = ref({ step: '', text: '' })
const bases = ref([])
const basesOpen = ref(false)
const chosenSheet = ref('')
// the name of what it tracks in, from the base or spreadsheet itself, for the ID it was asked for
const tablesName = ref({ id: '', name: '' })

// Electron wraps these in a line about the remote method
const reason = err => err.message.replace(/^Error invoking remote method '.*?': (Error: )?/, '')

const files = computed(() => edited.value.settings.files)
const airtable = computed(() => edited.value.settings.airtable)
const sheets = computed(() => edited.value.settings.googleSheets)
const target = computed(() => edited.value.settings.target ?? 'airtable')
const google = computed(() => target.value == 'googleSheets')

const tokenHint = computed(() => {
	if(!model.value.tokenKept)
		return "This computer has no keychain, so you'll need to enter it each time the app opens."
	return model.value.hasToken ? 'Kept in your keychain. Enter a new one to replace it.' : 'Kept in your keychain.'
})

// rules are kept as lists, and edited as a line each
const lines = (type, rule) => ({
	get: () => files.value.rules[type][rule].join('\n'),
	set: text => files.value.rules[type][rule] = text.split('\n').map(line => line.trim()).filter(line => line)
})

const rules = {
	fileIncludes: computed(lines('files', 'includes')),
	fileExcludes: computed(lines('files', 'excludes')),
	dirIncludes: computed(lines('dirs', 'includes')),
	dirExcludes: computed(lines('dirs', 'excludes')),
	dirSkips: computed(lines('dirs', 'skip'))
}

// an imported config from before Google Sheets won't have a section for it
function withDefaults(config) {
	const copy = JSON.parse(JSON.stringify(config))
	copy.settings.googleSheets ??= { spreadsheetId: '', credentials: '', foldersSheet: 'Folders', filesSheet: 'Files' }
	copy.settings.airtable ??= { token: '', base: '', foldersTable: 'Folders', filesTable: 'Files', view: '' }
	copy.settings.target ??= 'airtable'
	copy.settings.files.rootPath ??= ''
	copy.settings.files.trackFolders ??= true
	copy.settings.files.rules ??= {}
	for(const type of ['files', 'dirs'])
		copy.settings.files.rules[type] = { includes: [], excludes: [], ...copy.settings.files.rules[type] }
	copy.settings.files.rules.dirs.skip ??= []
	copy.settings.removing = { enabled: true, confirm: true, ...copy.settings.removing }
	return copy
}

// the steps, each done once it has what it needs
const done = computed(() => ({
	signIn: google.value
		? Boolean(model.value.signedIn?.google || sheets.value.credentials)
		: Boolean(model.value.signedIn?.airtable || model.value.hasToken),
	tables: Boolean(google.value ? sheets.value.spreadsheetId : airtable.value.base),
	files: files.value.dirs.length > 0
}))

const ruleCount = computed(() => Object.values(rules).reduce((total, rule) => total + (rule.value ? rule.value.split('\n').length : 0), 0))

const plural = (count, word) => `${count} ${word}${count == 1 ? '' : 's'}`
const folderName = dir => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir

const tablesId = computed(() => google.value ? sheets.value.spreadsheetId : airtable.value.base)
const named = id => (id && tablesName.value.id == id && tablesName.value.name) || id

// asked of the base or spreadsheet once it's saved, as it's only reached with what's saved
async function nameTables() {
	const id = tablesId.value
	if(!id || !done.value.signIn || tablesName.value.id == id)
		return
	tablesName.value = { id, name: '' }
	const name = await tracker.tablesName().catch(() => null)
	if(tablesId.value == id)
		tablesName.value = { id, name: name ?? '' }
}

const summaries = computed(() => ({
	signIn: google.value
		? `Google Sheets - ${model.value.signedIn?.google ? `signed in as ${model.value.signedIn.google}` : sheets.value.credentials ? 'with a service account' : 'not signed in'}`
		: `Airtable - ${model.value.signedIn?.airtable ? `signed in as ${model.value.signedIn.airtable}` : model.value.hasToken ? 'with a token' : 'not signed in'}`,
	tables: google.value
		? chosenSheet.value || named(sheets.value.spreadsheetId) || 'No spreadsheet yet'
		: bases.value.find(base => base.id == airtable.value.base)?.name || named(airtable.value.base) || 'No base yet',
	files: files.value.dirs.length ? files.value.dirs.map(folderName).join(', ') : 'No folders yet',
	filtering: ruleCount.value ? plural(ruleCount.value, 'rule') : 'Everything'
}))

// what's done starts folded, and folds as it's done: the rest stay open
const open = ref(remembered ?? { signIn: true, tables: true, files: true, filtering: false })
watch(open, value => remembered = { ...value }, { deep: true })

function finished(step, next) {
	open.value[step] = false
	if(next && !done.value[next])
		open.value[next] = true
}

// what was last sent to be saved, so its own echo coming back doesn't replace what's being typed
let sent = ''
let first = true

watch(() => model.value.config, config => {
	if(JSON.stringify(config) == sent)
		return
	edited.value = withDefaults(config)
	if(first) {
		first = false
		if(remembered)
			return
		for(const step of ['signIn', 'tables', 'files'])
			open.value[step] = !done.value[step]
	}
}, { immediate: true })

function took(result) {
	model.value = result
	problems.value = result.problems ?? []
	saved.value = !problems.value.length
}

async function save() {
	clearTimeout(timer)
	sent = JSON.stringify(edited.value)
	saving.value = true
	try {
		const result = await tracker.saveConfig(JSON.parse(sent), token.value)
		// keep what's here now, which may be newer than what was saved
		took({ ...result, config: JSON.parse(sent) })
		token.value = ''
		nameTables()
	}
	finally {
		saving.value = false
	}
}

// settings save themselves a moment after they're changed
let timer
watch(edited, () => {
	if(JSON.stringify(edited.value) == sent)
		return
	saved.value = false
	clearTimeout(timer)
	timer = setTimeout(save, 600)
}, { deep: true })

async function exportConfig() {
	await save()
	await tracker.exportConfig()
}

async function addFolder() {
	const folder = await tracker.pickFolder()
	if(!folder || files.value.dirs.includes(folder))
		return
	files.value.dirs.push(folder)
	files.value.rootPath ||= folder
}

// the Finder on a Mac, Explorer on Windows, and whatever opens folders on Linux
const showIn = /Mac/.test(navigator.userAgent) ? 'Show in Finder' : /Windows/.test(navigator.userAgent) ? 'Show in Explorer' : 'Show folder'

async function showFolder(dir) {
	try {
		// it has to be saved to be one it'll open
		await save()
		await tracker.showFolder(dir)
	}
	catch(err) {
		authError.value = { step: 'files', text: reason(err) }
	}
}

async function importConfig() {
	const result = await tracker.importConfig()
	if(result?.config)
		took(result)
	else if(result)
		problems.value = result.problems
}

async function pickCredentials() {
	sheets.value.credentials = await tracker.pickCredentials() ?? sheets.value.credentials
}

/**
 * Something that signs in or reaches the tables, saying in its step if it goes wrong
 */
async function attempt(step, action) {
	authError.value = { step: '', text: '' }
	busy.value = true
	try {
		await action()
	}
	catch(err) {
		authError.value = { step, text: reason(err) }
	}
	finally {
		busy.value = false
	}
}

let lastWait = 0

/**
 * Something done in the browser, which may never come back if its tab is closed: asking
 * again starts afresh, and only the latest says how it went
 */
async function inBrowser(kind, step, action) {
	const id = ++lastWait
	waiting.value = kind
	authError.value = { step: '', text: '' }
	try {
		await action()
	}
	catch(err) {
		if(id == lastWait)
			authError.value = { step, text: reason(err) }
	}
	finally {
		if(id == lastWait)
			waiting.value = ''
	}
}

function signIn(provider) {
	return inBrowser('signIn', 'signIn', async () => {
		const result = await tracker.signIn(provider)
		// null when it was stopped, by asking again or cancelling
		if(result) {
			keepEdits(result)
			finished('signIn', 'tables')
			nameTables()
		}
	})
}

const cancelBrowser = () => tracker.cancelBrowser()

async function signOut(provider) {
	keepEdits(await tracker.signOut(provider))
}

// signing in or out says nothing about the settings, so what's not saved yet stays
function keepEdits({ hasToken, signedIn, canSignIn, tokenKept }) {
	model.value = { ...model.value, hasToken, signedIn, canSignIn, tokenKept }
}

function setTarget(name) {
	edited.value.settings.target = name
	authError.value = { step: '', text: '' }
	basesOpen.value = false
}

// the list of bases drops down, and goes back up when one's chosen or it's pressed again
async function chooseBase() {
	if(basesOpen.value) {
		basesOpen.value = false
		return
	}
	await attempt('tables', async () => {
		// a token just typed in has to be saved before it can be used
		await save()
		bases.value = await tracker.airtableBases()
		if(!bases.value.length)
			throw new Error('There are no bases you\'ve given it access to.')
		basesOpen.value = true
	})
}

function pickBase(id) {
	airtable.value.base = id
	basesOpen.value = false
	finished('tables', 'files')
}

function useSpreadsheet(chosen) {
	if(!chosen)
		return
	sheets.value.spreadsheetId = chosen.id
	chosenSheet.value = chosen.name
	finished('tables', 'files')
}

const chooseSpreadsheet = () => inBrowser('choose', 'tables', async () => useSpreadsheet(await tracker.chooseSpreadsheet()))

const createSpreadsheet = () => attempt('tables', async () => {
	await save()
	useSpreadsheet(await tracker.createSpreadsheet())
})

const cacheMessage = ref('')

async function wipeCache() {
	try {
		await tracker.wipeCache()
		cacheMessage.value = 'Cleared'
	}
	catch(err) {
		cacheMessage.value = reason(err)
	}
}

// pressed once it asks, pressed again it resets, and anywhere else it doesn't
const resetting = ref(false)

async function reset() {
	if(!resetting.value) {
		resetting.value = true
		return
	}
	resetting.value = false
	clearTimeout(timer)
	const result = await tracker.resetConfig()
	sent = ''
	token.value = ''
	chosenSheet.value = ''
	bases.value = []
	basesOpen.value = false
	waiting.value = ''
	open.value = { signIn: true, tables: true, files: true, filtering: false }
	took(result)
	saved.value = false
}

async function clearToken() {
	keepEdits(await tracker.clearToken())
}

// what's tracked in, by name, as the settings open
nameTables()

const SERVICE_ACCOUNTS = 'https://github.com/garethnunns/content-tracker#with-a-service-account'
</script>

<template>
	<form class="settings" @submit.prevent="save">
		<div class="fields">
			<div v-if="problems.length" class="problems" role="alert" data-test="problems">
				<p>Settings saved, please resolve the following before running:</p>
				<ul>
					<li v-for="problem in problems" :key="problem">{{ problem }}</li>
				</ul>
			</div>

			<SettingsStep v-model:open="open.signIn" name="sign-in" :number="1" title="Authorisation" :summary="summaries.signIn" :done="done.signIn">
				<div class="row">
					<div class="toggle" :class="{ second: google }" role="radiogroup" aria-label="Tables">
						<span class="slider" aria-hidden="true" />
						<button type="button" role="radio" :aria-checked="!google" @click="setTarget('airtable')">Airtable</button>
						<button type="button" role="radio" :aria-checked="google" @click="setTarget('googleSheets')">Google Sheets</button>
					</div>

					<template v-if="!google && model.canSignIn?.airtable">
						<template v-if="model.signedIn?.airtable">
							<span data-test="airtable-account">Signed in as {{ model.signedIn.airtable }}</span>
							<button type="button" class="quiet" @click="signOut('airtable')">Sign out</button>
						</template>
						<button v-else type="button" class="primary" data-test="sign-in-airtable" @click="signIn('airtable')">Sign in with Airtable</button>
					</template>

					<template v-if="google && model.canSignIn?.google">
						<template v-if="model.signedIn?.google">
							<span data-test="google-account">Signed in as {{ model.signedIn.google }}</span>
							<button type="button" class="quiet" @click="signOut('google')">Sign out</button>
						</template>
						<button v-else type="button" class="primary" data-test="sign-in-google" @click="signIn('google')">Sign in with Google</button>
					</template>
				</div>

				<p v-if="waiting == 'signIn'" class="hint" role="status">
					Waiting for you to sign in, in your browser…
					<button type="button" class="text" data-test="cancel-browser" @click="cancelBrowser">Cancel</button>
				</p>
				<p v-if="authError.step == 'signIn'" class="auth-error" role="alert" data-test="auth-error">{{ authError.text }}</p>

				<details v-if="!google" :open="model.hasToken || !model.canSignIn?.airtable">
					<summary>{{ model.canSignIn?.airtable ? 'Or use a token' : 'Token' }}</summary>
					<SettingField label="Token" :hint="tokenHint">
						<input v-model="token" type="password" autocomplete="off" :placeholder="model.hasToken ? 'Saved' : ''" data-test="token" @change="save">
					</SettingField>
					<div v-if="model.hasToken">
						<button type="button" class="quiet" @click="clearToken">Forget token</button>
					</div>
				</details>
				<p v-else-if="!model.canSignIn?.google" class="hint">Use a service account, in the next step.</p>
			</SettingsStep>

			<SettingsStep v-model:open="open.tables" name="tables" :number="2" title="Tables" :summary="summaries.tables" :done="done.tables">
				<template v-if="google">
					<div class="field-group">
						<div class="row">
							<template v-if="model.canSignIn?.google">
								<button type="button" class="primary" :disabled="!model.signedIn?.google || busy" data-test="choose-spreadsheet" @click="chooseSpreadsheet">Choose from Drive</button>
								<button type="button" :disabled="!model.signedIn?.google || busy" data-test="create-spreadsheet" @click="createSpreadsheet">New spreadsheet</button>
							</template>
							<input v-model="sheets.spreadsheetId" class="link" spellcheck="false" placeholder="Or paste its link" aria-label="Spreadsheet" data-test="spreadsheet" @input="chosenSheet = ''">
						</div>
						<span v-if="waiting == 'choose'" class="hint" role="status">
							Waiting for you to choose it, in your browser…
							<button type="button" class="text" data-test="cancel-browser" @click="cancelBrowser">Cancel</button>
						</span>
						<span v-else-if="chosenSheet" class="hint" data-test="chosen-spreadsheet">{{ chosenSheet }}</span>
						<span v-else class="hint">A link only works for one chosen here before, or shared with a service account.</span>
					</div>

					<p v-if="authError.step == 'tables'" class="auth-error" role="alert" data-test="auth-error">{{ authError.text }}</p>

					<details :open="Boolean(sheets.credentials) || !model.canSignIn?.google">
						<summary>Or use a service account</summary>
						<p class="hint">
							For a computer no one signs in on: a Google robot account that you share the spreadsheet with.
							<a :href="SERVICE_ACCOUNTS">How to set one up</a>
						</p>
						<div class="picker">
							<input v-model="sheets.credentials" spellcheck="false" placeholder="Its key, a .json file" aria-label="Service account key">
							<button type="button" @click="pickCredentials">Choose</button>
						</div>
					</details>

					<div class="columns">
						<SettingField label="Folders sheet">
							<input v-model="sheets.foldersSheet" spellcheck="false">
						</SettingField>
						<SettingField label="Files sheet">
							<input v-model="sheets.filesSheet" spellcheck="false">
						</SettingField>
					</div>
				</template>

				<template v-else>
					<div class="field-group">
						<div class="row">
							<button type="button" class="primary dropdown-button" :class="{ open: basesOpen }" :aria-expanded="basesOpen" :disabled="(!model.signedIn?.airtable && !model.hasToken && !token) || busy" data-test="choose-base" @click="chooseBase">
								Choose base <span class="caret" aria-hidden="true" />
							</button>
							<input v-model="airtable.base" class="link" spellcheck="false" placeholder="Or paste its ID (app...)" aria-label="Base ID" data-test="base">
						</div>
						<div class="dropdown" :class="{ open: basesOpen }" :inert="!basesOpen">
							<ul class="bases" data-test="bases">
								<li v-for="base in bases" :key="base.id">
									<button type="button" :class="{ active: base.id == airtable.base }" @click="pickBase(base.id)">
										{{ base.name }} <small>{{ base.id }}</small>
									</button>
								</li>
							</ul>
						</div>
					</div>

					<p v-if="authError.step == 'tables'" class="auth-error" role="alert" data-test="auth-error">{{ authError.text }}</p>

					<div class="columns">
						<SettingField label="Folders table" hint="A name, or a table's ID.">
							<input v-model="airtable.foldersTable" spellcheck="false">
						</SettingField>
						<SettingField label="Files table" hint="A name, or a table's ID.">
							<input v-model="airtable.filesTable" spellcheck="false">
						</SettingField>
					</div>

					<details :open="Boolean(airtable.view)">
						<summary>More options</summary>
						<SettingField label="View" hint="Only compare against this view, which both tables need. Usually left empty.">
							<input v-model="airtable.view" spellcheck="false">
						</SettingField>
					</details>
				</template>
			</SettingsStep>

			<SettingsStep v-model:open="open.files" name="files" :number="3" title="Files" :summary="summaries.files" :done="done.files">
				<div class="field-group">
					<div class="row spread">
						<span class="heading">Folders to track</span>
						<button type="button" data-test="add-folder" @click="addFolder">Add folder</button>
					</div>
					<ul v-if="files.dirs.length" class="folders" data-test="folders">
						<li v-for="(dir, index) in files.dirs" :key="dir">
							<span>{{ dir }}</span>
							<span class="folder-actions">
								<button type="button" class="quiet" :aria-label="`${showIn}: ${dir}`" @click="showFolder(dir)">{{ showIn }}</button>
								<button type="button" class="quiet" :aria-label="`Remove ${dir}`" @click="files.dirs.splice(index, 1)">Remove</button>
							</span>
						</li>
					</ul>
					<span v-else class="hint">The folder your project's media is in.</span>
				</div>
				<p v-if="authError.step == 'files'" class="auth-error" role="alert">{{ authError.text }}</p>

				<SettingField label="Project root" hint="Removed from the start of paths, so it doesn't matter where the folders are mounted.">
					<input v-model="files.rootPath" spellcheck="false" data-test="root-path">
				</SettingField>

				<div class="checks">
					<label class="check">
						<input v-model="files.mediaMetadata" type="checkbox">
						<span>Media metadata <small>Duration, codec, resolution, etc.</small></span>
					</label>
					<label class="check">
						<input v-model="files.trackFolders" type="checkbox" data-test="track-folders">
						<span>Track folders <small>As well as the files</small></span>
					</label>
					<label class="check">
						<input v-model="files.limitToFirstFile" type="checkbox">
						<span>First file only <small>One per folder, for image sequences</small></span>
					</label>
					<label class="check">
						<input v-model="edited.settings.removing.enabled" type="checkbox" data-test="removing">
						<span>Remove deleted files <small>From the tables too</small></span>
					</label>
					<label class="check">
						<input v-model="edited.settings.removing.confirm" type="checkbox" :disabled="!edited.settings.removing.enabled" data-test="confirm-removing">
						<span>Ask before removing over 10%</span>
					</label>
				</div>

				<details>
					<summary>More options</summary>
					<div class="columns">
						<SettingField label="Check every (seconds)" hint="How often it looks for changes while watching.">
							<input v-model.number="files.frequency" type="number" min="0">
						</SettingField>
						<SettingField label="Files at once" hint="Lower this for streamed drives.">
							<input v-model.number="files.concurrency" type="number" min="1">
						</SettingField>
					</div>
					<div class="field-group">
						<div>
							<button type="button" data-test="wipe-cache" @click="wipeCache">Clear media metadata cache</button>
							<span v-if="cacheMessage" class="cache-message" role="status" data-test="cache-message">{{ cacheMessage }}</span>
						</div>
						<span class="hint">Reads every file's metadata again on the next run.</span>
					</div>
				</details>
			</SettingsStep>

			<SettingsStep v-model:open="open.filtering" name="filtering" :number="4" title="Filtering" :summary="summaries.filtering">
				<p class="intro">One per line, like <code>*.mov</code> or <code>shots/**</code>. Leave them empty to track everything.</p>
				<div class="columns">
					<SettingField label="Include files" tip="Only files that match one of these are tracked.">
						<textarea v-model="rules.fileIncludes.value" spellcheck="false" />
					</SettingField>
					<SettingField label="Exclude files" tip="Files that match any of these aren't tracked.">
						<textarea v-model="rules.fileExcludes.value" spellcheck="false" />
					</SettingField>
					<SettingField label="Include folders" tip="Only folders that match one of these get a record. Files in the others are still found.">
						<textarea v-model="rules.dirIncludes.value" spellcheck="false" />
					</SettingField>
					<SettingField label="Exclude folders" tip="Folders that match any of these don't get a record. Files in them are still found.">
						<textarea v-model="rules.dirExcludes.value" spellcheck="false" />
					</SettingField>
					<SettingField label="Skip folders" tip="Folders that match any of these aren't looked in, so nothing in them is tracked.">
						<textarea v-model="rules.dirSkips.value" spellcheck="false" />
					</SettingField>
				</div>
			</SettingsStep>
		</div>

		<footer>
			<button type="button" title="Use settings from a config file, like the command line's" @click="importConfig">Import settings</button>
			<button type="button" title="Save these settings as a config file, for the command line or another computer - without your token or sign ins" data-test="export" @click="exportConfig">Export settings</button>
			<span v-if="saving" class="saved">Saving…</span>
			<span v-else-if="saved" class="saved" data-test="saved">Saved</span>
			<span class="reset">
				<button v-if="resetting" type="button" class="quiet" @click="resetting = false">Keep them</button>
				<button type="button" :class="{ danger: resetting }" data-test="reset" @click="reset" @blur="resetting = false">{{ resetting ? 'Sure? This signs you out too' : 'Reset settings' }}</button>
			</span>
		</footer>
	</form>
</template>

<style scoped>
/* the fields scroll, the buttons stay where they are below them */
.settings {
	display: flex;
	flex-direction: column;
	height: 100%;
}

.fields {
	display: flex;
	flex: 1;
	flex-direction: column;
	gap: 10px;
	min-height: 0;
	overflow: auto;
	padding: 18px max(20px, calc((100% - 680px) / 2));
}

.intro {
	margin: 0;
	color: var(--text-soft);
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.row.spread {
	justify-content: space-between;
}

.columns {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 12px;
}

.field-group {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.heading {
	font-weight: 500;
}

.hint,
small {
	margin: 0;
	color: var(--text-soft);
	font-size: 12px;
}

/* the two to choose between, with what's chosen sliding across */
.toggle {
	position: relative;
	display: inline-grid;
	grid-template-columns: 1fr 1fr;
	padding: 2px;
	background: var(--background);
	border: 1px solid var(--border);
	border-radius: 8px;
}

.slider {
	position: absolute;
	top: 2px;
	bottom: 2px;
	left: 2px;
	width: calc(50% - 2px);
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 6px;
	transition: transform 0.25s ease;
}

.toggle.second .slider {
	transform: translateX(100%);
}

.toggle button {
	position: relative;
	padding: 5px 14px;
	background: none;
	border: 0;
	color: var(--text-soft);
	transition: color 0.2s;
}

.toggle button[aria-checked='true'] {
	color: var(--text);
}

/* typed in rather than chosen, so it's there without standing out */
input.link {
	flex: 1;
	min-width: 180px;
	background: none;
	border-style: dashed;
}

.dropdown-button {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

.caret {
	width: 6px;
	height: 6px;
	margin-top: -3px;
	border-right: 1.5px solid currentColor;
	border-bottom: 1.5px solid currentColor;
	transform: rotate(45deg);
	transition: transform 0.25s ease, margin 0.25s ease;
}

.dropdown-button.open .caret {
	margin-top: 3px;
	transform: rotate(225deg);
}

.dropdown {
	display: grid;
	grid-template-rows: 0fr;
	opacity: 0;
	/* hidden once it's folded, and not before */
	visibility: hidden;
	transition: grid-template-rows 0.25s ease, opacity 0.2s ease, visibility 0s 0.25s;
}

.dropdown.open {
	grid-template-rows: 1fr;
	opacity: 1;
	visibility: visible;
	transition: grid-template-rows 0.25s ease, opacity 0.2s ease;
}

.bases {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-height: 0;
	margin: 0;
	padding: 0;
	overflow: hidden;
	list-style: none;
}

.bases button {
	width: 100%;
	text-align: left;
}

.bases button.active {
	border-color: var(--accent);
}

.folders {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.folders li {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 4px 4px 4px 10px;
	background: var(--background);
	border: 1px solid var(--border);
	border-radius: 7px;
	overflow-wrap: anywhere;
}

.folder-actions {
	display: flex;
	flex-shrink: 0;
}

.folder-actions button {
	white-space: nowrap;
}

.picker {
	display: flex;
	gap: 8px;
}

details {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

summary {
	color: var(--text-soft);
	cursor: pointer;
}

/* a button that reads as a link, in a line of text */
button.text {
	padding: 0;
	background: none;
	border: 0;
	color: var(--accent);
	font-size: inherit;
}

.cache-message {
	margin-left: 8px;
	color: var(--text-soft);
}

.auth-error {
	margin: 0;
	color: var(--error);
}

.checks {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
	gap: 8px 12px;
}

.check {
	display: flex;
	align-items: center;
	gap: 8px;
}

.problems {
	padding: 8px 12px;
	border: 1px solid var(--warning);
	border-radius: 7px;
}

.problems p,
.problems ul {
	margin: 0;
}

.problems ul {
	padding-left: 18px;
}

footer {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 12px max(20px, calc((100% - 680px) / 2));
	border-top: 1px solid var(--border);
}

.saved {
	color: var(--success);
}

.reset {
	display: flex;
	gap: 6px;
	margin-left: auto;
}

button.danger {
	background: var(--error);
	border-color: var(--error);
	color: var(--accent-text);
}

@media (prefers-reduced-motion: reduce) {
	.slider,
	.toggle button,
	.caret,
	.dropdown {
		transition: none;
	}
}
</style>
