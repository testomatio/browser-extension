// The inline "new folder / new suite" row on the Tests tab's tree: one field, a tick and a cross.

/* global $, state, TestomatAPI, Tooltip, StatusIcons, toast, resetTcTreeSearch, rememberSuiteEmoji,
   renderSuiteTree */

const TcSuiteCreate = {
  // Created during the visit, newest first: the API appends new suites at the end, off-screen.
  justCreated: [],

  close() {
    for (const el of document.querySelectorAll('.tc-new-suite')) el.remove();
  },

  // `mount(li)` places the row at the top of its list, one row under the button that opened it.
  open({ parentId, fileType, mount }) {
    TcSuiteCreate.close();
    const folder = fileType === 'folder';
    const li = document.createElement('li');
    li.className = 'tc-item tree-node tc-new-suite';
    const row = document.createElement('div');
    row.className = 'list-row tc-row list-head tree-row tree-input-row';
    row.classList.add('has-chevron');
    row.append(folder ? StatusIcons.treeIcon(StatusIcons.CHEVRON, 'chevron') : StatusIcons.treeSlot());
    const mark = folder ? StatusIcons.FOLDER : StatusIcons.FILE;
    row.append(StatusIcons.treeIcon(mark, folder ? 'folder-icon' : 'file-icon'));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-input';
    input.autocomplete = 'off';
    input.placeholder = folder ? 'Enter folder name' : 'Enter suite name';
    input.setAttribute('aria-label', folder ? 'New folder name' : 'New suite name');

    // Buttons keep the field's focus on mousedown: the row cancels on focusout, before their click.
    const iconBtn = (icon, cls, tip) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `icon-btn size-xs ${cls}`;
      b.append(StatusIcons.svgIcon(icon, 16));
      b.setAttribute('aria-label', tip);
      Tooltip.set(b, tip);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };
    const ok = iconBtn('check', 'tc-new-suite-ok', folder ? 'Create folder' : 'Create suite');
    const cancel = iconBtn('close', 'tc-new-suite-cancel', 'Cancel');
    row.append(input, ok, cancel);
    li.append(row);
    mount(li);
    input.focus();

    let busy = false;
    const submit = async () => {
      const title = input.value.trim();
      if (!title || busy) return;
      busy = true;
      ok.disabled = true; cancel.disabled = true;
      try {
        const made = await TestomatAPI.createSuite({ title, parentId, fileType });
        if (made?.id) TcSuiteCreate.justCreated.unshift(String(made.id)); // keeps it in the row it was named in
        if (parentId) state.tcExpanded[String(parentId)] = true;
        resetTcTreeSearch(); // a live filter would hide a node whose title misses it
        state.tcSuites = await TestomatAPI.getSuiteTreeOrdered();
        rememberSuiteEmoji(state.tcSuites); // the run view's suite marks read the same tree
        renderSuiteTree(state.tcSuites); // re-render replaces the input row
      } catch (e) {
        busy = false;
        ok.disabled = false; cancel.disabled = false;
        toast(e.message || String(e)); // keep the row + typed title
      }
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', TcSuiteCreate.close);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); TcSuiteCreate.close(); }
    });
    // Focus leaving the row cancels; a create in flight owns the row until it answers.
    row.addEventListener('focusout', (e) => {
      if (busy || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      TcSuiteCreate.close();
    });
  },

  // Two skins: `.tc-new` is the hover pill on a tree row; the empty state passes the shared button.
  addButtons(openFor, cls = 'btn size-xs tc-new') {
    const frag = document.createDocumentFragment();
    const mk = (label, fileType, tip) => {
      const b = document.createElement('button');
      b.className = cls;
      b.append(StatusIcons.svgIcon('add', 16), document.createTextNode(label));
      Tooltip.set(b, tip);
      b.addEventListener('click', (e) => { e.stopPropagation(); openFor(fileType); });
      return b;
    };
    frag.append(mk('Suite', 'file', 'New test suite here'), mk('Folder', 'folder', 'New folder here'));
    return frag;
  },

  // Mounts at the tree top and scrolls itself in, for a tree already scrolled down.
  openRoot(fileType) {
    TcSuiteCreate.open({
      parentId: null,
      fileType,
      mount: (row) => { $('tc-tree').prepend(row); row.scrollIntoView({ block: 'nearest' }); },
    });
  },
};
