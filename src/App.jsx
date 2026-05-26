import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  FileArchive,
  Hash,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  QrCode,
  Save,
  ScanLine,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import QRCode from 'qrcode';
import JSZip from 'jszip';
import { get, onValue, push, ref, set, update } from 'firebase/database';
import { adminPasscode, database } from './firebase';

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'tel', label: 'Phone' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'textarea', label: 'Long text' },
  { value: 'checkbox', label: 'Checkbox' },
];

const EMPTY_FIELD = {
  label: '',
  key: '',
  type: 'text',
  required: false,
  options: '',
};

function makeHash() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeKey(label) {
  return slugify(label).replace(/-/g, '_');
}

function formatDate(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function cleanScannedValue(value) {
  const trimmed = String(value || '').trim();
  const withoutControlChars = trimmed.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  try {
    const url = new URL(withoutControlChars);
    return url.searchParams.get('hash') || url.pathname.split('/').filter(Boolean).pop() || withoutControlChars;
  } catch {
    return withoutControlChars;
  }
}

function getScannedHashCandidates(value) {
  const cleanValue = cleanScannedValue(value);
  const candidates = [cleanValue];
  const hashMatches = cleanValue.match(/\b[a-fA-F0-9]{32,64}\b/g) || [];
  hashMatches.forEach((match) => candidates.push(match.toLowerCase()));
  return [...new Set(candidates.filter(Boolean))];
}

function wrapCanvasText(context, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  words.forEach((word) => {
    const nextLine = line ? `${line} ${word}` : word;
    if (context.measureText(nextLine).width <= maxWidth) {
      line = nextLine;
      return;
    }
    if (line) lines.push(line);
    line = word;
  });

  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

async function createLabeledQrDataUrl(hash, label) {
  const qrSize = 960;
  const padding = 32;
  const labelHeight = 180;
  const canvas = document.createElement('canvas');
  const qrCanvas = document.createElement('canvas');
  canvas.width = qrSize + padding * 2;
  canvas.height = qrSize + padding * 2 + labelHeight;

  await QRCode.toCanvas(qrCanvas, hash, {
    width: qrSize,
    margin: 3,
    errorCorrectionLevel: 'H',
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(qrCanvas, padding, padding, qrSize, qrSize);

  context.fillStyle = '#111827';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.font = '700 42px Arial, sans-serif';

  const lines = wrapCanvasText(context, label, canvas.width - padding * 2).slice(0, 2);
  const lineHeight = 52;
  const startY = padding + qrSize + 34;
  lines.forEach((line, index) => {
    context.fillText(line, canvas.width / 2, startY + index * lineHeight);
  });

  return canvas.toDataURL('image/png');
}

function parseCsv(text) {
  const rows = [[]];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      rows[rows.length - 1].push(cell);
      cell = '';
      if (char === '\r' && next === '\n') index += 1;
      rows.push([]);
    } else {
      cell += char;
    }
  }

  rows[rows.length - 1].push(cell);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows.filter((row) => row.some((value) => String(value || '').trim()));
}

function getXmlElements(parent, localName) {
  return Array.from(parent.getElementsByTagNameNS('*', localName));
}

function resolveZipPath(fromPath, target) {
  if (!target) return '';
  const parts = target.startsWith('/') ? target.slice(1).split('/') : [...fromPath.split('/').slice(0, -1), ...target.split('/')];
  const normalized = [];

  parts.forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  });

  return normalized.join('/');
}

function getCellColumnIndex(cellReference = '') {
  const letters = cellReference.match(/[A-Z]+/i)?.[0] || '';
  return letters.split('').reduce((total, letter) => total * 26 + letter.toUpperCase().charCodeAt(0) - 64, 0) - 1;
}

function getCellText(cell, sharedStrings) {
  const type = cell.getAttribute('t');
  const value = getXmlElements(cell, 'v')[0]?.textContent || '';

  if (type === 's') return sharedStrings[Number(value)] || '';
  if (type === 'inlineStr') return getXmlElements(cell, 't').map((node) => node.textContent || '').join('');
  if (type === 'b') return value === '1' ? 'true' : 'false';
  return value;
}

async function parseXlsx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const parser = new DOMParser();
  const workbookFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');

  if (!workbookFile || !relsFile) throw new Error('This Excel file is missing workbook data.');

  const workbookDoc = parser.parseFromString(await workbookFile.async('string'), 'application/xml');
  const relsDoc = parser.parseFromString(await relsFile.async('string'), 'application/xml');
  const firstSheet = getXmlElements(workbookDoc, 'sheet')[0];
  const relId = firstSheet?.getAttribute('r:id') || firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const sheetRel = getXmlElements(relsDoc, 'Relationship').find((rel) => rel.getAttribute('Id') === relId);
  const sheetPath = resolveZipPath('xl/workbook.xml', sheetRel?.getAttribute('Target'));
  const sheetFile = zip.file(sheetPath);

  if (!sheetFile) throw new Error('Could not read the first Excel sheet.');

  const sharedStringsFile = zip.file('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsFile
    ? getXmlElements(parser.parseFromString(await sharedStringsFile.async('string'), 'application/xml'), 'si').map((item) =>
        getXmlElements(item, 't').map((node) => node.textContent || '').join(''),
      )
    : [];

  const sheetDoc = parser.parseFromString(await sheetFile.async('string'), 'application/xml');
  return getXmlElements(sheetDoc, 'row')
    .map((row) => {
      const values = [];
      getXmlElements(row, 'c').forEach((cell, fallbackIndex) => {
        const index = Math.max(0, getCellColumnIndex(cell.getAttribute('r')) || fallbackIndex);
        values[index] = getCellText(cell, sharedStrings);
      });
      return values.map((value) => value ?? '');
    })
    .filter((row) => row.some((value) => String(value || '').trim()));
}

function getUniqueImportFields(headers) {
  const seen = new Map();

  return headers.map((header, index) => {
    const label = String(header || `Column ${index + 1}`).trim() || `Column ${index + 1}`;
    const baseKey = normalizeKey(label) || `column_${index + 1}`;
    const count = seen.get(baseKey) || 0;
    seen.set(baseKey, count + 1);

    return {
      label,
      key: count ? `${baseKey}_${count + 1}` : baseKey,
      type: 'text',
      required: false,
      options: '',
    };
  });
}

function getImportLabelField(fields) {
  return fields.find((field) => ['label', 'lable'].includes(normalizeKey(field.label)));
}

async function readTableFile(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'xlsx') return parseXlsx(await file.arrayBuffer());
  if (extension === 'xls') throw new Error('Save older Excel files as .xlsx or CSV first.');
  return parseCsv(await file.text());
}

function getImportedRows(file, rows) {
  if (rows.length < 2) throw new Error('Upload a file with one header row and at least one data row.');

  const fields = getUniqueImportFields(rows[0]);
  const labelField = getImportLabelField(fields);
  if (!labelField) throw new Error('Add a column named label or lable for QR labels.');

  const dataRows = rows.slice(1).map((row) =>
    fields.reduce((details, field, index) => {
      details[field.key] = String(row[index] ?? '').trim();
      return details;
    }, {}),
  ).filter((details) => Object.values(details).some(Boolean));

  if (!dataRows.length) throw new Error('No data rows found after the header row.');

  return {
    schemaName: file.name.replace(/\.[^.]+$/, '') || 'Imported QR Batch',
    fields,
    labelKey: labelField.key,
    dataRows,
  };
}

function App() {
  const [activeTab, setActiveTab] = useState('generate');
  const [schemas, setSchemas] = useState([]);
  const [entries, setEntries] = useState([]);
  const [isUnlocked, setIsUnlocked] = useState(() => {
    return !adminPasscode || sessionStorage.getItem('event-qr-unlocked') === 'true';
  });

  useEffect(() => {
    const unsubSchemas = onValue(ref(database, 'schemas'), (snapshot) => {
      const value = snapshot.val() || {};
      const next = Object.entries(value)
        .map(([id, schema]) => ({ id, ...schema }))
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      setSchemas(next);
    });

    const unsubEntries = onValue(ref(database, 'qrEntries'), (snapshot) => {
      const value = snapshot.val() || {};
      const next = Object.entries(value)
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      setEntries(next);
    });

    return () => {
      unsubSchemas();
      unsubEntries();
    };
  }, []);

  const stats = useMemo(() => {
    const updated = entries.filter((entry) => entry.status === 'updated').length;
    const teams = entries.filter((entry) => entry.entityType === 'team').length;
    return {
      schemas: schemas.length,
      entries: entries.length,
      updated,
      teams,
    };
  }, [entries, schemas]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <span className="brand-mark">
              <QrCode size={22} />
            </span>
            <span>Event QR Studio</span>
          </div>
          <p>Schema-led QR batches with hash-only payloads.</p>
        </div>
        <div className="status-pill">
          <ShieldCheck size={17} />
          {isUnlocked ? 'Unlocked' : 'Locked'}
        </div>
      </header>

      {!isUnlocked ? (
        <UnlockPanel onUnlock={() => setIsUnlocked(true)} />
      ) : (
        <>
          <section className="stats-grid" aria-label="Workspace stats">
            <Stat icon={<Settings2 size={18} />} label="Schemas" value={stats.schemas} />
            <Stat icon={<QrCode size={18} />} label="QRs" value={stats.entries} />
            <Stat icon={<Check size={18} />} label="Updated" value={stats.updated} />
            <Stat icon={<Users size={18} />} label="Teams" value={stats.teams} />
          </section>

          <nav className="tabs" aria-label="Main sections">
            <TabButton active={activeTab === 'generate'} icon={<FileArchive size={18} />} onClick={() => setActiveTab('generate')}>
              Generate
            </TabButton>
            <TabButton active={activeTab === 'schemas'} icon={<Layers size={18} />} onClick={() => setActiveTab('schemas')}>
              Schemas
            </TabButton>
            <TabButton active={activeTab === 'scan'} icon={<ScanLine size={18} />} onClick={() => setActiveTab('scan')}>
              Scan
            </TabButton>
          </nav>

          {activeTab === 'generate' && <Generator schemas={schemas} entries={entries} />}
          {activeTab === 'schemas' && <SchemaDesigner schemas={schemas} />}
          {activeTab === 'scan' && <Scanner schemas={schemas} />}
        </>
      )}
    </div>
  );
}

function UnlockPanel({ onUnlock }) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    if (!adminPasscode || passcode === adminPasscode) {
      sessionStorage.setItem('event-qr-unlocked', 'true');
      onUnlock();
      return;
    }
    setError('Passcode did not match.');
  }

  return (
    <main className="single-panel">
      <section className="panel compact-panel">
        <div className="section-heading">
          <span className="icon-badge">
            <KeyRound size={18} />
          </span>
          <div>
            <h1>Admin Passcode</h1>
            <p>Use the passcode from your environment file.</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label>
            <span>Passcode</span>
            <input
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" type="submit">
            <ShieldCheck size={18} />
            Unlock
          </button>
        </form>
      </section>
    </main>
  );
}

function Generator({ schemas, entries }) {
  const [schemaId, setSchemaId] = useState('');
  const [entityType, setEntityType] = useState('individual');
  const [quantity, setQuantity] = useState(10);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!schemaId && schemas.length) setSchemaId(schemas[0].id);
  }, [schemaId, schemas]);

  const selectedSchema = schemas.find((schema) => schema.id === schemaId);

  async function generateBatch(event) {
    event.preventDefault();
    if (!selectedSchema) {
      setMessage('Create a schema first.');
      return;
    }

    const qrLabel = selectedSchema.qrLabel?.trim();
    if (!qrLabel) {
      setMessage('Edit this schema and add a QR label first.');
      return;
    }

    const total = Math.max(1, Math.min(500, Number(quantity) || 1));
    setBusy(true);
    setMessage('');

    try {
      const zip = new JSZip();
      const manifest = [];
      const updates = {};
      const now = Date.now();
      const safePrefix = slugify(qrLabel || selectedSchema.name || entityType) || 'qr';

      for (let index = 1; index <= total; index += 1) {
        const hash = makeHash();
        const serial = String(index).padStart(String(total).length, '0');
        const label = `${qrLabel} ${serial}`;
        const filename = `${safePrefix}-${serial}-${hash.slice(0, 8)}.png`;

        const dataUrl = await createLabeledQrDataUrl(hash, label);

        zip.file(filename, dataUrl.split(',')[1], { base64: true });
        manifest.push({
          hash,
          label,
          qrLabel,
          filename,
          entityType,
          schemaId: selectedSchema.id,
          schemaName: selectedSchema.name,
        });

        updates[`qrEntries/${hash}`] = {
          hash,
          label,
          entityType,
          schemaId: selectedSchema.id,
          schemaName: selectedSchema.name,
          qrLabel,
          status: 'open',
          details: {},
          createdAt: now,
          updatedAt: now,
        };
      }

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      await update(ref(database), updates);
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${safePrefix}-${entityType}-qr.zip`);
      setMessage(`${total} ${entityType} QR ${total === 1 ? 'code' : 'codes'} generated.`);
    } catch (error) {
      setMessage(error.message || 'Could not generate QR batch.');
    } finally {
      setBusy(false);
    }
  }

  async function generateFromTableFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setMessage('');

    try {
      const imported = getImportedRows(file, await readTableFile(file));
      const zip = new JSZip();
      const manifest = [];
      const updates = {};
      const now = Date.now();
      const schemaId = push(ref(database, 'schemas')).key;
      const safePrefix = slugify(imported.schemaName) || 'imported-qr';

      updates[`schemas/${schemaId}`] = {
        name: imported.schemaName,
        qrLabel: imported.schemaName,
        description: `Imported from ${file.name}`,
        fields: imported.fields,
        createdAt: now,
        updatedAt: now,
      };

      for (let index = 0; index < imported.dataRows.length; index += 1) {
        const details = imported.dataRows[index];
        const hash = makeHash();
        const serial = String(index + 1).padStart(String(imported.dataRows.length).length, '0');
        const label = String(details[imported.labelKey] || `${imported.schemaName} ${serial}`).trim();
        const filename = `${safePrefix}-${serial}-${slugify(label).slice(0, 32) || hash.slice(0, 8)}-${hash.slice(0, 8)}.png`;
        const dataUrl = await createLabeledQrDataUrl(hash, label);

        zip.file(filename, dataUrl.split(',')[1], { base64: true });
        manifest.push({
          hash,
          label,
          filename,
          entityType,
          schemaId,
          schemaName: imported.schemaName,
          details,
        });

        updates[`qrEntries/${hash}`] = {
          hash,
          label,
          entityType,
          schemaId,
          schemaName: imported.schemaName,
          qrLabel: label,
          status: 'updated',
          details,
          createdAt: now,
          updatedAt: now,
        };
      }

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      await update(ref(database), updates);
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `${safePrefix}-${entityType}-qr.zip`);
      setSchemaId(schemaId);
      setMessage(`${imported.dataRows.length} QR ${imported.dataRows.length === 1 ? 'code' : 'codes'} generated from ${file.name}.`);
    } catch (error) {
      setMessage(error.message || 'Could not generate QR batch from file.');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  return (
    <main className="two-column">
      <section className="panel">
        <div className="section-heading">
          <span className="icon-badge">
            <FileArchive size={18} />
          </span>
          <div>
            <h1>Batch Generator</h1>
            <p>Downloads a ZIP and stores each hash in Firebase.</p>
          </div>
        </div>

        <form className="form-grid" onSubmit={generateBatch}>
          <label className="full">
            <span>QR Schema</span>
            <select value={schemaId} onChange={(event) => setSchemaId(event.target.value)}>
              {schemas.length === 0 && <option value="">No schemas yet</option>}
              {schemas.map((schema) => (
                <option key={schema.id} value={schema.id}>
                  {schema.name}
                </option>
              ))}
            </select>
          </label>

          <div className="segmented full" role="group" aria-label="QR owner type">
            <button type="button" className={entityType === 'individual' ? 'active' : ''} onClick={() => setEntityType('individual')}>
              <Hash size={17} />
              Individual
            </button>
            <button type="button" className={entityType === 'team' ? 'active' : ''} onClick={() => setEntityType('team')}>
              <Users size={17} />
              Team
            </button>
          </div>

          <label>
            <span>Quantity</span>
            <input
              type="number"
              min="1"
              max="500"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>

          <label>
            <span>QR label</span>
            <input value={selectedSchema?.qrLabel || ''} readOnly placeholder="Set in schema" />
          </label>

          <button className="primary-button full" type="submit" disabled={busy || !schemas.length}>
            {busy ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
            {busy ? 'Generating' : 'Generate ZIP'}
          </button>
        </form>

        <div className="import-block">
          <div>
            <h2>Generate From File</h2>
            <p>Upload CSV or XLSX with the first row as fields and a label/lable column.</p>
          </div>
          <label className={`file-button ${busy ? 'disabled' : ''}`}>
            <input
              type="file"
              accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={generateFromTableFile}
              disabled={busy}
            />
            {busy ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
            Upload file
          </label>
        </div>

        {message && <p className="toast-line">{message}</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <span className="icon-badge">
            <QrCode size={18} />
          </span>
          <div>
            <h2>Recent QR Entries</h2>
            <p>QR payloads are hashes only.</p>
          </div>
        </div>

        <div className="entry-list">
          {entries.slice(0, 12).map((entry) => (
            <article className="entry-row" key={entry.hash}>
              <div>
                <strong>{entry.label || entry.hash.slice(0, 10)}</strong>
                <span>{entry.schemaName || 'Unknown schema'} · {entry.entityType}</span>
              </div>
              <span className={`state-chip ${entry.status === 'updated' ? 'done' : ''}`}>
                {entry.status || 'open'}
              </span>
            </article>
          ))}
          {entries.length === 0 && <div className="empty-state">Generated entries will appear here.</div>}
        </div>
      </section>
    </main>
  );
}

function SchemaDesigner({ schemas }) {
  const [name, setName] = useState('');
  const [qrLabel, setQrLabel] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState([
    { ...EMPTY_FIELD, label: 'Name', key: 'name', required: true },
    { ...EMPTY_FIELD, label: 'Phone', key: 'phone', type: 'tel' },
  ]);
  const [editingId, setEditingId] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  function resetForm() {
    setName('');
    setQrLabel('');
    setDescription('');
    setEditingId('');
    setFields([
      { ...EMPTY_FIELD, label: 'Name', key: 'name', required: true },
      { ...EMPTY_FIELD, label: 'Phone', key: 'phone', type: 'tel' },
    ]);
  }

  function editSchema(schema) {
    setEditingId(schema.id);
    setName(schema.name || '');
    setQrLabel(schema.qrLabel || schema.name || '');
    setDescription(schema.description || '');
    setFields(schema.fields?.length ? schema.fields : [{ ...EMPTY_FIELD }]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateField(index, patch) {
    setFields((current) =>
      current.map((field, fieldIndex) => {
        if (fieldIndex !== index) return field;
        const next = { ...field, ...patch };
        if (patch.label !== undefined && (!field.key || field.key === normalizeKey(field.label))) {
          next.key = normalizeKey(patch.label);
        }
        return next;
      }),
    );
  }

  async function saveSchema(event) {
    event.preventDefault();
    const cleanFields = fields
      .map((field) => ({
        label: field.label.trim(),
        key: normalizeKey(field.key || field.label),
        type: field.type,
        required: Boolean(field.required),
        options: field.type === 'select' ? field.options : '',
      }))
      .filter((field) => field.label && field.key);

    if (!name.trim() || !qrLabel.trim() || cleanFields.length === 0) {
      setMessage('Add a schema name, QR label, and at least one field.');
      return;
    }

    setSaving(true);
    try {
      const now = Date.now();
      const schemaRef = editingId ? ref(database, `schemas/${editingId}`) : push(ref(database, 'schemas'));
      await set(schemaRef, {
        name: name.trim(),
        qrLabel: qrLabel.trim(),
        description: description.trim(),
        fields: cleanFields,
        createdAt: editingId ? schemas.find((schema) => schema.id === editingId)?.createdAt || now : now,
        updatedAt: now,
      });
      setMessage(editingId ? 'Schema updated.' : 'Schema created.');
      resetForm();
    } catch (error) {
      setMessage(error.message || 'Could not save schema.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="two-column schema-layout">
      <section className="panel">
        <div className="section-heading">
          <span className="icon-badge">
            <Settings2 size={18} />
          </span>
          <div>
            <h1>{editingId ? 'Edit Schema' : 'New Schema'}</h1>
            <p>Define the form shown after scanning a hash.</p>
          </div>
        </div>

        <form className="form-stack" onSubmit={saveSchema}>
          <label>
            <span>Schema name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Freshers Night, Booth Leads..." />
          </label>
          <label>
            <span>QR label</span>
            <input
              value={qrLabel}
              onChange={(event) => setQrLabel(event.target.value)}
              placeholder="Freshers Night Guest"
              required
            />
          </label>
          <label>
            <span>Description</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows="3" />
          </label>

          <div className="field-editor">
            {fields.map((field, index) => (
              <div className="field-card" key={`${index}-${field.key}`}>
                <div className="field-card-header">
                  <strong>Field {index + 1}</strong>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label="Remove field"
                    onClick={() => setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}
                    disabled={fields.length === 1}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <div className="form-grid tight">
                  <label>
                    <span>Label</span>
                    <input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} />
                  </label>
                  <label>
                    <span>Key</span>
                    <input value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} />
                  </label>
                  <label>
                    <span>Type</span>
                    <select value={field.type} onChange={(event) => updateField(index, { type: event.target.value })}>
                      {FIELD_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(event) => updateField(index, { required: event.target.checked })}
                    />
                    <span>Required</span>
                  </label>
                  {field.type === 'select' && (
                    <label className="full">
                      <span>Options</span>
                      <input
                        value={field.options}
                        onChange={(event) => updateField(index, { options: event.target.value })}
                        placeholder="VIP, Regular, Staff"
                      />
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="action-row">
            <button type="button" className="secondary-button" onClick={() => setFields((current) => [...current, { ...EMPTY_FIELD }])}>
              <Plus size={18} />
              Add field
            </button>
            {editingId && (
              <button type="button" className="ghost-button" onClick={resetForm}>
                Cancel
              </button>
            )}
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
              Save
            </button>
          </div>
        </form>

        {message && <p className="toast-line">{message}</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <span className="icon-badge">
            <Layers size={18} />
          </span>
          <div>
            <h2>Saved Schemas</h2>
            <p>{schemas.length} available for QR generation.</p>
          </div>
        </div>
        <div className="schema-list">
          {schemas.map((schema) => (
            <button className="schema-row" key={schema.id} type="button" onClick={() => editSchema(schema)}>
              <div>
                <strong>{schema.name}</strong>
                <span>{schema.qrLabel || 'No QR label'} · {schema.fields?.length || 0} fields · {formatDate(schema.updatedAt)}</span>
              </div>
              <ChevronRight size={18} />
            </button>
          ))}
          {schemas.length === 0 && <div className="empty-state">Create your first event schema.</div>}
        </div>
      </section>
    </main>
  );
}

function Scanner({ schemas }) {
  const scannerRef = useRef(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState('');
  const [entry, setEntry] = useState(null);
  const [schema, setSchema] = useState(null);
  const [values, setValues] = useState({});
  const [message, setMessage] = useState('');

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, []);

  async function stopScanner() {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop();
      await scannerRef.current.clear();
    }
    setRunning(false);
  }

  async function startScanner() {
    setMessage('');
    try {
      if (!scannerRef.current) scannerRef.current = new Html5Qrcode('qr-reader');
      await scannerRef.current.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 260, height: 260 },
          aspectRatio: 1,
        },
        async (decodedText) => {
          await stopScanner();
          await loadEntry(decodedText);
        },
      );
      setRunning(true);
    } catch (error) {
      setMessage(error.message || 'Camera could not start.');
    }
  }

  async function scanFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMessage('');
    try {
      if (!scannerRef.current) scannerRef.current = new Html5Qrcode('qr-reader');
      const decodedText = await scannerRef.current.scanFile(file, true);
      await loadEntry(decodedText);
    } catch (error) {
      setMessage(error.message || 'Could not read QR from image.');
    } finally {
      event.target.value = '';
    }
  }

  async function loadEntry(rawValue = hash) {
    const hashCandidates = getScannedHashCandidates(rawValue);
    if (!hashCandidates.length) return;
    setBusy(true);
    setMessage('');
    setHash(hashCandidates[0]);

    try {
      let snapshot = null;
      let matchedHash = '';

      for (const candidate of hashCandidates) {
        const candidateSnapshot = await get(ref(database, `qrEntries/${candidate}`));
        if (candidateSnapshot.exists()) {
          snapshot = candidateSnapshot;
          matchedHash = candidate;
          break;
        }
      }

      if (!snapshot) {
        snapshot = await get(ref(database, `qrEntries/${hashCandidates[0]}`));
      }

      if (!snapshot.exists()) {
        setEntry(null);
        setSchema(null);
        setValues({});
        setMessage('Fake QR');
        return;
      }

      const loadedEntry = snapshot.val();
      setHash(matchedHash || loadedEntry.hash || hashCandidates[0]);
      const localSchema = schemas.find((item) => item.id === loadedEntry.schemaId);
      let loadedSchema = localSchema;
      if (!loadedSchema && loadedEntry.schemaId) {
        const schemaSnapshot = await get(ref(database, `schemas/${loadedEntry.schemaId}`));
        loadedSchema = schemaSnapshot.exists() ? { id: loadedEntry.schemaId, ...schemaSnapshot.val() } : null;
      }

      setEntry(loadedEntry);
      setSchema(loadedSchema);
      setValues(loadedEntry.details || {});
      setMessage(loadedSchema ? 'Entry loaded.' : 'Entry loaded, but schema is missing.');
    } catch (error) {
      setMessage(error.message || 'Could not load entry.');
    } finally {
      setBusy(false);
    }
  }

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function saveEntry(event) {
    event.preventDefault();
    if (!entry || !schema) return;

    const missing = (schema.fields || []).filter((field) => {
      const value = values[field.key];
      return field.required && (value === undefined || value === null || value === '');
    });

    if (missing.length) {
      setMessage(`Missing: ${missing.map((field) => field.label).join(', ')}`);
      return;
    }

    setBusy(true);
    try {
      const now = Date.now();
      const historyId = push(ref(database, `scanHistory/${entry.hash}`)).key;
      await update(ref(database), {
        [`qrEntries/${entry.hash}/details`]: values,
        [`qrEntries/${entry.hash}/status`]: 'updated',
        [`qrEntries/${entry.hash}/updatedAt`]: now,
        [`qrEntries/${entry.hash}/lastScannedAt`]: now,
        [`scanHistory/${entry.hash}/${historyId}`]: {
          details: values,
          updatedAt: now,
        },
      });
      setEntry((current) => ({ ...current, details: values, status: 'updated', updatedAt: now, lastScannedAt: now }));
      setMessage('Entry updated.');
    } catch (error) {
      setMessage(error.message || 'Could not update entry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="two-column scanner-layout">
      <section className="panel scanner-panel">
        <div className="section-heading">
          <span className="icon-badge">
            <ScanLine size={18} />
          </span>
          <div>
            <h1>Scanner</h1>
            <p>Scan a QR hash and update its Firebase entry.</p>
          </div>
        </div>

        <div id="qr-reader" className="qr-reader" />

        <div className="action-row scan-actions">
          <button type="button" className="primary-button" onClick={running ? stopScanner : startScanner}>
            <ScanLine size={18} />
            {running ? 'Stop camera' : 'Start camera'}
          </button>
          <label className="file-button">
            <input type="file" accept="image/*" onChange={scanFile} />
            <QrCode size={18} />
            Image
          </label>
        </div>

        <div className="manual-load">
          <input value={hash} onChange={(event) => setHash(event.target.value)} placeholder="Hash code" />
          <button type="button" className="secondary-button" onClick={() => loadEntry(hash)} disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <ChevronRight size={18} />}
            Load
          </button>
        </div>

        {message && <p className="toast-line">{message}</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <span className="icon-badge">
            <Save size={18} />
          </span>
          <div>
            <h2>{entry ? entry.label || entry.hash : 'Entry Details'}</h2>
            <p>{entry ? `${entry.schemaName || 'Schema'} · ${entry.entityType}` : 'No hash loaded.'}</p>
          </div>
        </div>

        {entry && schema ? (
          <form className="form-stack" onSubmit={saveEntry}>
            <div className="hash-strip">
              <Hash size={16} />
              <code>{entry.hash}</code>
            </div>

            {(schema.fields || []).map((field) => (
              <FieldInput key={field.key} field={field} value={values[field.key]} onChange={(value) => updateValue(field.key, value)} />
            ))}

            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
              Update entry
            </button>
          </form>
        ) : (
          <div className="empty-state">Scan or load a hash to edit details.</div>
        )}
      </section>
    </main>
  );
}

function FieldInput({ field, value, onChange }) {
  const commonProps = {
    id: field.key,
    value: value ?? '',
    required: field.required,
    onChange: (event) => onChange(event.target.value),
  };

  if (field.type === 'textarea') {
    return (
      <label>
        <span>{field.label}{field.required ? ' *' : ''}</span>
        <textarea {...commonProps} rows="4" />
      </label>
    );
  }

  if (field.type === 'select') {
    const options = String(field.options || '')
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean);
    return (
      <label>
        <span>{field.label}{field.required ? ' *' : ''}</span>
        <select {...commonProps}>
          <option value="">Select</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <label className="checkbox-line">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}{field.required ? ' *' : ''}</span>
      </label>
    );
  }

  return (
    <label>
      <span>{field.label}{field.required ? ' *' : ''}</span>
      <input {...commonProps} type={field.type} />
    </label>
  );
}

function Stat({ icon, label, value }) {
  return (
    <div className="stat-card">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function TabButton({ active, icon, children, onClick }) {
  return (
    <button type="button" className={active ? 'active' : ''} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

export default App;
