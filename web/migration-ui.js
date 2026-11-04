export function mountMigration({ run, notify }) {
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props),
    dialog = el('dialog', { id: 'migration-dialog' }),
    heading = el('h2', { textContent: 'Migrate a photo catalog' }),
    help = el('p'),
    output = el('output'),
    roots = el('div'),
    actions = el('div'),
    close = el('button', { textContent: 'Close' }),
    commit = el('button', { textContent: 'Migrate available originals' }),
    inspect = el('button', { textContent: 'Check files / retry missing' }),
    retry = el('button', { textContent: 'Resume last scan' }),
    catalog = el('input', { type: 'file', accept: '.lrcat' }),
    folder = el('button', { textContent: 'Choose exported originals folder…' })
  catalog.setAttribute('aria-label', 'Lightroom Classic catalog')
  output.setAttribute('aria-live', 'polite')
  output.style.whiteSpace = 'pre-wrap'
  output.style.display = 'block'
  dialog.style.maxWidth = '760px'
  dialog.style.maxHeight = '85vh'
  dialog.style.overflow = 'auto'
  dialog.setAttribute('aria-label', 'Catalog migration')
  actions.append(inspect, commit, retry, close)
  dialog.append(heading, help, catalog, folder, roots, output, actions)
  document.body.append(dialog)
  let id = '',
    kind = 'lrcat'
  const error = (value) => {
    output.textContent = value.message
    notify(value.message)
  }
  async function busy(work) {
    for (const node of [catalog, folder, inspect, commit, retry]) node.disabled = true
    try {
      await work()
    } catch (value) {
      error(value)
    } finally {
      for (const node of [catalog, folder, inspect, commit, retry]) node.disabled = false
    }
  }
  function result(value) {
    id = value.id
    roots.replaceChildren()
    output.textContent = value.imported
      ? `Imported ${value.imported.length}; already present ${value.existing.length}; relinked ${value.relinked.length}; missing/unmapped ${value.missing.length}; failed ${value.failed.length}.\n` +
        value.failed.map((row) => row.name + ': ' + row.error).join('\n')
      : `${value.total} photo records; ${value.originals ?? '?'} original files; ${value.available ?? 0} available; ${value.missing ?? 0} missing; ${value.unmapped ?? value.total} unmapped; ${value.incomplete ?? 0} incomplete.\n` +
        (value.photos ?? [])
          .filter((row) => row.status !== 'available')
          .map((row) => row.sourcePath + ' · ' + row.status)
          .join('\n')
    output.textContent += '\n' + (value.warnings ?? []).map((row) => row.message).join('\n')
    for (const root of value.roots ?? []) {
      const row = el('p'),
        label = el('span', {
          textContent:
            root.path +
            ' → ' +
            (value.mappings?.find((item) => item.sourceRoot === root.id)?.targetPath ?? 'not mapped') +
            ' '
        }),
        button = el('button', { textContent: 'Choose matching folder…' })
      button.onclick = () => busy(async () => result(await run('migration-map', { id, sourceRoot: root.id })))
      row.append(label, button)
      roots.append(row)
    }
  }
  catalog.onchange = () =>
    busy(async () => {
      if (catalog.files[0]) result(await run('migration-scan', { catalog: catalog.files[0] }))
    })
  folder.onclick = () =>
    busy(async () => {
      const chosen = await run('migration-folder')
      if (chosen) result(await run('migration-apple-scan', { root: chosen.id }))
    })
  inspect.onclick = () =>
    busy(async () => {
      if (!id) throw Error('Scan a catalog or exported folder first')
      result(await run('migration-inspect', { id }))
    })
  commit.onclick = () =>
    busy(async () => {
      if (!id) throw Error('Scan and map originals first')
      result(await run('migration-commit', { id }))
      notify('Migration report is ready')
    })
  retry.onclick = () =>
    busy(async () => {
      const plans = await run('migration-report'),
        last = plans.filter((plan) => plan.kind === kind).sort((a, b) => b.created - a.created)[0]
      if (!last) throw Error('No saved migration scan')
      result(await run('migration-inspect', { id: last.id }))
    })
  close.onclick = () => dialog.close()
  const entry = el('details'),
    summary = el('summary', { textContent: 'Migrate photo catalogs' }),
    classic = el('button', { textContent: 'Lightroom Classic catalog…' }),
    apple = el('button', { textContent: 'Apple Photos exported originals…' })
  classic.onclick = () => run('migrate-lrcat').catch(error)
  apple.onclick = () => run('migrate-apple-photos').catch(error)
  entry.append(summary, classic, apple)
  document.querySelector('nav').append(entry)
  return {
    show(next = 'lrcat') {
      kind = next
      id = ''
      roots.replaceChildren()
      output.textContent = ''
      catalog.hidden = next !== 'lrcat'
      folder.hidden = next === 'lrcat'
      heading.textContent =
        next === 'lrcat' ? 'Migrate Lightroom Classic catalog' : 'Migrate Apple Photos exported originals'
      help.textContent =
        next === 'lrcat'
          ? 'Close Lightroom Classic, select a catalog, then map each old root path to the exact originals folder. Review file counts before migration. Originals stay at their authorized locations; missing files can be retried. Supported edits are approximate.'
          : 'In Apple Photos on Mac, select photos and Export Unmodified Originals with Export IPTC as XMP. Choose only that exported resources folder here. Export into named album folders to retain those groupings. This does not read a private Photos Library database or reproduce Photos edits.'
      if (!dialog.open) dialog.showModal()
      return { kind: next, desktop: Boolean(globalThis.mygo?.call) }
    }
  }
}
