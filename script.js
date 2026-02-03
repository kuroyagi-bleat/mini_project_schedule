// --- State Management ---

// OLD State Structure (Reference):
// { anchorDate, phases:[], ... }

// V2 State Structure:
// { activeTimelineId, timelines: [ { data: { holidays: [] } } ] }

// V3 State Structure (Current):
// {
//   activeTimelineId: "uuid",
//   globalHolidays: [], // Shared across all timelines
//   timelines: [
//      { id: "uuid", name: "Sprint 1", data: { anchorDate, phases:[], ... } } // No holidays here
//   ]
// }

const defaultPhaseConfig = [
    { id: '1', name: 'リリース準備', days: 1 },
    { id: '2', name: '受入テスト', days: 3 },
    { id: '3', name: '総合テスト', days: 5 },
    { id: '4', name: '結合テスト', days: 5 },
    { id: '5', name: '実装・単体テスト', days: 10 },
    { id: '6', name: '詳細設計', days: 5 },
    { id: '7', name: '基本設計', days: 5 },
    { id: '8', name: '要件定義', days: 5 },
];

const createDefaultTimelineData = () => ({
    anchorDate: new Date().toISOString().split('T')[0],
    anchorPhaseId: '1',
    anchorType: 'end',
    sortOrder: 'asc',
    // Holidays removed from here
    phases: JSON.parse(JSON.stringify(defaultPhaseConfig))
});

let appState = {
    activeTimelineId: null,
    globalHolidays: [],
    timelines: []
};

// --- Storage & Migration ---

function saveState() {
    localStorage.setItem('scheduleAppState', JSON.stringify(appState));
}

function loadState() {
    const rawNew = localStorage.getItem('scheduleAppState');
    const rawOld = localStorage.getItem('scheduleState');

    if (rawNew) {
        try {
            const parsed = JSON.parse(rawNew);

            // Migration V2 -> V3 (Lift holidays to global)
            if (!parsed.globalHolidays && parsed.timelines) {
                // Take holidays from the first timeline if available
                const firstWithHolidays = parsed.timelines.find(t => t.data && t.data.holidays && t.data.holidays.length > 0);
                parsed.globalHolidays = firstWithHolidays ? firstWithHolidays.data.holidays : [];

                // Cleanup individual holidays
                parsed.timelines.forEach(t => {
                    if (t.data && t.data.holidays) delete t.data.holidays;
                });
            }

            appState = parsed;
            if (!appState.timelines || !Array.isArray(appState.timelines)) throw new Error("Invalid structure");
            if (!appState.globalHolidays) appState.globalHolidays = [];

        } catch (e) {
            console.error("Failed to parse app state, resetting.", e);
            resetToDefault();
        }
    } else if (rawOld) {
        // Migrate V1 -> V3
        try {
            const oldData = JSON.parse(rawOld);
            const newId = Date.now().toString();

            const holidays = oldData.holidays || [];
            if (oldData.holidays) delete oldData.holidays; // Remove from data object

            appState = {
                activeTimelineId: newId,
                globalHolidays: holidays,
                timelines: [
                    {
                        id: newId,
                        name: 'Default Timeline',
                        data: oldData
                    }
                ]
            };
            validateTimelineData(appState.timelines[0].data);
            saveState();
        } catch (e) {
            console.error("Migration failed", e);
            resetToDefault();
        }
    } else {
        resetToDefault();
    }
}

function resetToDefault() {
    const id = Date.now().toString();
    appState = {
        activeTimelineId: id,
        globalHolidays: [],
        timelines: [
            {
                id: id,
                name: 'Sprint 1',
                data: createDefaultTimelineData()
            }
        ]
    };
    saveState();
}

function validateTimelineData(data) {
    if (!data.phases) data.phases = JSON.parse(JSON.stringify(defaultPhaseConfig));
    // Holidays no longer checked here
    if (!data.anchorType) data.anchorType = 'end';
    if (!data.sortOrder) data.sortOrder = 'asc';
}

function getActiveTimeline() {
    const t = appState.timelines.find(t => t.id === appState.activeTimelineId);
    return t ? t : appState.timelines[0];
}

function getActiveData() {
    return getActiveTimeline().data;
}


// --- Date Helpers ---

function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
}

function normalizeDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isHoliday(date) {
    // Changed: Read from global State
    const str = normalizeDateStr(date);
    return appState.globalHolidays.includes(str);
}

function isWorkingDay(date) {
    return !isWeekend(date) && !isHoliday(date);
}

function subBusinessDays(startDate, daysToSubtract) {
    let date = new Date(startDate.getTime());
    let daysLeft = daysToSubtract;
    while (daysLeft > 0) {
        date.setDate(date.getDate() - 1);
        if (isWorkingDay(date)) daysLeft--;
    }
    return date;
}

function addBusinessDays(startDate, daysToAdd) {
    let date = new Date(startDate.getTime());
    let daysLeft = daysToAdd;
    while (daysLeft > 0) {
        date.setDate(date.getDate() + 1);
        if (isWorkingDay(date)) daysLeft--;
    }
    return date;
}

function ensureWorkingDayBackward(date) {
    let d = new Date(date.getTime());
    while (!isWorkingDay(d)) d.setDate(d.getDate() - 1);
    return d;
}

function ensureWorkingDayForward(date) {
    let d = new Date(date.getTime());
    while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
    return d;
}


// --- Logic ---

function calculateSchedule(targetData = null) {
    const data = targetData || getActiveData();
    if (!data.anchorDate || !data.phases.length) return null;

    const anchorIndex = data.phases.findIndex(p => p.id === data.anchorPhaseId);
    if (anchorIndex === -1 && data.phases.length > 0) {
        data.anchorPhaseId = data.phases[0].id;
        return calculateSchedule(data);
    }
    if (anchorIndex === -1) return [];

    const results = new Array(data.phases.length);
    const anchorDateObj = new Date(data.anchorDate);
    const anchorPhase = data.phases[anchorIndex];

    // --- Helper: Process Parallel Items ---
    // Parallel items do not affect the RefDate chain.
    const processParallel = (idx) => {
        const p = data.phases[idx];
        if (p.isParallel) {
            // Use manual dates if present, else default to today? 
            // Better: if missing, keep them null or try to preserve days?
            // If user just checked "Parallel", we might not have dates yet.
            // Let's assume input validation or fallback.
            // Fallback: Anchor Date start, + days.
            let s = p.manualStartDate ? new Date(p.manualStartDate) : new Date(data.anchorDate);
            let e = p.manualEndDate ? new Date(p.manualEndDate) : addBusinessDays(s, p.days - 1);

            // Recalculate days based on range? 
            // User requirement: "End Date (Input) ... enabled".
            // So we trust the dates.
            // Update the p.days for display?
            const diff = getDaysDiff(s, e);
            // p.days = diff; // Should we mutate data here? ideally valid update happens in Input listener.
            // But results should reflect it.
            return { ...p, startDate: s, endDate: e, days: diff };
        }
        return null;
    };


    // --- Anchor Calculation ---
    // If Anchor is parallel, it breaks the chain logic. Anchor MUST be sequential.
    // Ideally we prevent this in UI, but handle here safely.
    // If Anchor IS parallel, we treat it as an isolated parallel task?
    // Then what references the others?
    // Let's assume Anchor IS sequential (enforced in UI).

    let anchorStart, anchorEnd;

    if (data.anchorType === 'end') {
        anchorEnd = ensureWorkingDayBackward(anchorDateObj);
        anchorStart = subBusinessDays(anchorEnd, Math.max(0, anchorPhase.days - 1));
    } else {
        anchorStart = ensureWorkingDayForward(anchorDateObj);
        anchorEnd = addBusinessDays(anchorStart, Math.max(0, anchorPhase.days - 1));
    }

    results[anchorIndex] = { ...anchorPhase, startDate: anchorStart, endDate: anchorEnd };

    // --- Preceding Chain ---
    let nextRefDate = anchorStart;
    for (let i = anchorIndex - 1; i >= 0; i--) {
        const parallelRes = processParallel(i);
        if (parallelRes) {
            results[i] = parallelRes;
            // Do NOT update nextRefDate
            continue;
        }

        // Sequential
        let end = subBusinessDays(nextRefDate, 1);
        let start = subBusinessDays(end, Math.max(0, data.phases[i].days - 1));
        results[i] = { ...data.phases[i], startDate: start, endDate: end };
        nextRefDate = start;
    }

    // --- Succeeding Chain ---
    let prevRefDate = anchorEnd;
    for (let i = anchorIndex + 1; i < data.phases.length; i++) {
        const parallelRes = processParallel(i);
        if (parallelRes) {
            results[i] = parallelRes;
            // Do NOT update prevRefDate
            continue;
        }

        // Sequential
        let start = addBusinessDays(prevRefDate, 1);
        let end = addBusinessDays(start, Math.max(0, data.phases[i].days - 1));
        results[i] = { ...data.phases[i], startDate: start, endDate: end };
        prevRefDate = end;
    }

    return results;
}

// --- Render Logic ---

let phaseListEl, resultContainerEl, anchorDateInput, holidaysInput, anchorPhaseSelect, anchorTypeRadios;
let timelineSelect, addTimelineBtn, renameTimelineBtn, deleteTimelineBtn;

function bindDOMElements() {
    phaseListEl = document.getElementById('phase-list');
    resultContainerEl = document.getElementById('result-container');
    anchorDateInput = document.getElementById('anchor-date-input');
    holidaysInput = document.getElementById('holidays-input');
    anchorPhaseSelect = document.getElementById('anchor-phase-select');
    anchorTypeRadios = document.querySelectorAll('input[name="top-anchor-type"]');

    // New Controls
    timelineSelect = document.getElementById('timeline-select');
    addTimelineBtn = document.getElementById('add-timeline-btn');
    renameTimelineBtn = document.getElementById('rename-timeline-btn');
    deleteTimelineBtn = document.getElementById('delete-timeline-btn');
}

function renderTimelineSelect() {
    if (!timelineSelect) return;
    timelineSelect.innerHTML = '';
    appState.timelines.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        if (t.id === appState.activeTimelineId) opt.selected = true;
        timelineSelect.appendChild(opt);
    });
}

function renderPhases() {
    if (!phaseListEl) return;
    phaseListEl.innerHTML = '';

    const data = getActiveData();
    renderAnchorSelect();

    // Calculate schedule to show dates in the list
    const schedule = calculateSchedule(data);
    const dateMap = {};
    if (schedule) {
        schedule.forEach((s, i) => {
            dateMap[data.phases[i].id] = { start: s.startDate, end: s.endDate };
        });
    }

    data.phases.forEach((phase, index) => {
        const row = document.createElement('div');
        row.className = 'phase-row draggable-item';
        row.dataset.idx = index;
        row.draggable = true;

        const isAnchor = data.anchorPhaseId === phase.id;
        const isParallel = !!phase.isParallel;
        const activeStyle = isAnchor ? 'border-left: 3px solid var(--accent-primary); background: rgba(56,189,248,0.1);' : '';

        row.style.cssText = activeStyle;

        // Parallel Logic: If parallel, Manual Dates Enabled, Days Disabled (calculated).
        // If Sequential, Manual Dates Disabled (Text), Days Enabled.

        // Consolidate Logic: Always use inputs.
        // If parallel: value = manualDate, enabled.
        // If sequential: value = calculatedDate, disabled.

        let startDateVal = phase.manualStartDate || '';
        let endDateVal = phase.manualEndDate || '';

        if (!isParallel) {
            const sDates = dateMap[phase.id];
            if (sDates) {
                // Format YYYY-MM-DD for input[type=date]
                const iso = (d) => {
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${y}-${m}-${day}`;
                };
                startDateVal = iso(sDates.start);
                endDateVal = iso(sDates.end);
            }
        }

        row.innerHTML = `
      <div style="cursor: grab; padding-right:0.5rem; color:var(--text-secondary); display:flex; flex-direction:column; align-items:center; justify-content:center; width: 30px;">
         <span style="font-size:1.2rem;">⋮⋮</span>
         <span style="font-size:0.7rem; font-weight:bold;">#${index + 1}</span>
      </div>
      
      <div style="flex-grow:1; display:flex; align-items: center; gap:0.5rem;">
         <div style="flex-grow:1; display:flex; flex-direction:column; gap:0.2rem;">
             <input type="text" class="phase-name-input" value="${phase.name}" data-idx="${index}" style="font-weight:bold; width:100%; border:none; background:transparent; border-bottom:1px solid var(--glass-border); padding:0.2rem 0;">
             ${isAnchor ? `<div style="font-size:0.75rem; color:var(--accent-primary);">📌 Anchor (${data.anchorType === 'start' ? 'Start' : 'End'})</div>` : ''}
         </div>
         
         <!-- Parallel Checkbox (Icon only) -->
         <label title="並行作業 (自動計算から除外)" style="cursor:pointer; display:flex; align-items:center; padding: 0.2rem;">
            <input type="checkbox" class="phase-parallel-chk" data-idx="${index}" ${isParallel ? 'checked' : ''} ${isAnchor ? 'disabled' : ''}>
         </label>
      </div>
      
      <!-- Date/Days Area -->
      <div style="display:flex; flex-direction:column; gap:0.2rem; align-items:flex-end; min-width: 140px;">
          <div style="display:flex; gap:0.2rem; justify-content: flex-end; height: 24px; align-items: center;">
            <input type="date" class="phase-start-input" data-idx="${index}" value="${startDateVal}" 
                   style="width:105px; font-size:0.75rem; padding:0.1rem; ${!isParallel ? 'color:var(--text-secondary); border:none; background:transparent;' : ''}" 
                   ${!isParallel ? 'disabled' : ''}>
            <span style="font-size:0.75rem;">-</span>
            <input type="date" class="phase-end-input" data-idx="${index}" value="${endDateVal}" 
                   style="width:105px; font-size:0.75rem; padding:0.1rem; ${!isParallel ? 'color:var(--text-secondary); border:none; background:transparent;' : ''}" 
                   ${!isParallel ? 'disabled' : ''}>
          </div>

          <div style="display:flex; align-items:center; gap:0.3rem">
            <input type="number" class="phase-days-input" value="${phase.days}" min="1" data-idx="${index}" 
                   style="width:70px !important; text-align:right; font-size: 0.9rem;" 
                   ${isParallel ? 'readonly style="background:transparent; border:none; color:var(--text-secondary); width:70px !important; text-align:right;"' : ''}>
            <span style="font-size:0.75rem; color:var(--text-secondary)">days</span>
          </div>
      </div>

      <button class="icon-btn delete-btn" data-idx="${index}" title="削除" style="margin-left: 0.5rem;">
        🗑️
      </button>
    `;
        phaseListEl.appendChild(row);
    });

    attachPhaseListeners();
    attachDragListeners();
    updateTopControls();
}

function renderAnchorSelect() {
    if (!anchorPhaseSelect) return;
    const data = getActiveData();
    anchorPhaseSelect.innerHTML = '';
    data.phases.forEach(phase => {
        const opt = document.createElement('option');
        opt.value = phase.id;
        opt.textContent = phase.name;
        opt.selected = phase.id === data.anchorPhaseId;
        anchorPhaseSelect.appendChild(opt);
    });
}

function updateTopControls() {
    const data = getActiveData();
    if (anchorTypeRadios) {
        anchorTypeRadios.forEach(radio => {
            radio.checked = radio.value === data.anchorType;
        });
    }
    if (anchorDateInput && anchorDateInput.value !== data.anchorDate) {
        anchorDateInput.value = data.anchorDate;
    }
    // Update Holidays Input from GLOBAL state
    if (holidaysInput) {
        holidaysInput.value = (appState.globalHolidays || []).join('\n');
    }
}

function attachPhaseListeners() {
    document.querySelectorAll('.phase-name-input').forEach(el => {
        el.addEventListener('input', (e) => {
            const data = getActiveData();
            data.phases[e.target.dataset.idx].name = e.target.value;
            saveState();
            renderAnchorSelect();
            updateSchedule();
        });
    });

    // NEW: Parallel Checkbox
    document.querySelectorAll('.phase-parallel-chk').forEach(el => {
        el.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const data = getActiveData();
            const phase = data.phases[idx];

            // Validation: Anchor cannot be parallel (Double check)
            if (data.anchorPhaseId === phase.id) {
                alert("Anchor phase cannot be set to parallel.");
                e.target.checked = false;
                return;
            }

            phase.isParallel = e.target.checked;

            // Init default manual dates if becoming parallel
            if (phase.isParallel) {
                if (!phase.manualStartDate) phase.manualStartDate = data.anchorDate;
                if (!phase.manualEndDate) phase.manualEndDate = data.anchorDate;
            }

            saveState();
            renderPhases();
            updateSchedule();
        });
    });

    // NEW: Manual Date Inputs
    document.querySelectorAll('.phase-start-input').forEach(el => {
        el.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const data = getActiveData();
            data.phases[idx].manualStartDate = e.target.value;
            // Auto update days?
            const s = new Date(data.phases[idx].manualStartDate);
            const eDate = new Date(data.phases[idx].manualEndDate || data.phases[idx].manualStartDate);
            if (!isNaN(s) && !isNaN(eDate)) {
                data.phases[idx].days = getDaysDiff(s, eDate);
            }
            saveState();
            updateSchedule(); // Re-render logic will update calculated fields
        });
    });

    document.querySelectorAll('.phase-end-input').forEach(el => {
        el.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const data = getActiveData();
            data.phases[idx].manualEndDate = e.target.value;
            // Auto update days
            const s = new Date(data.phases[idx].manualStartDate || data.phases[idx].manualEndDate);
            const eDate = new Date(data.phases[idx].manualEndDate);
            if (!isNaN(s) && !isNaN(eDate)) {
                data.phases[idx].days = getDaysDiff(s, eDate);
            }
            saveState();
            updateSchedule();
        });
    });

    document.querySelectorAll('.phase-days-input').forEach(el => {
        el.addEventListener('input', (e) => {
            if (e.target.readOnly) return; // Ignore if parallel
            const val = parseInt(e.target.value) || 0;
            const data = getActiveData();
            data.phases[e.target.dataset.idx].days = Math.max(1, val);
            saveState();
            updateSchedule();
        });
    });

    document.querySelectorAll('.delete-btn').forEach(el => {
        el.addEventListener('click', (e) => {
            const btn = e.target.closest('.delete-btn');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx);
            const data = getActiveData();
            const deletedId = data.phases[idx].id;

            if (deletedId === data.anchorPhaseId) {
                data.phases.splice(idx, 1);
                data.anchorPhaseId = data.phases[0]?.id || '';
            } else {
                data.phases.splice(idx, 1);
            }
            saveState();
            renderPhases();
            updateSchedule();
        });
    });
}

function attachDragListeners() {
    const draggables = document.querySelectorAll('.draggable-item');
    draggables.forEach(draggable => {
        draggable.addEventListener('dragstart', (e) => {
            draggable.classList.add('dragging');
            e.dataTransfer.setData('text/plain', draggable.dataset.idx);
            e.dataTransfer.effectAllowed = 'move';
        });
        draggable.addEventListener('dragend', () => {
            draggable.classList.remove('dragging');
            document.querySelectorAll('.phase-row').forEach(row => row.classList.remove('drag-over'));
        });
        draggable.addEventListener('dragover', (e) => {
            e.preventDefault();
            const draggingItem = document.querySelector('.dragging');
            if (draggable !== draggingItem) draggable.classList.add('drag-over');
        });
        draggable.addEventListener('dragleave', () => draggable.classList.remove('drag-over'));
        draggable.addEventListener('drop', (e) => {
            e.preventDefault();
            draggable.classList.remove('drag-over');
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
            const toIdx = parseInt(draggable.dataset.idx);
            if (fromIdx === toIdx) return;

            const data = getActiveData();
            const movedItem = data.phases.splice(fromIdx, 1)[0];
            data.phases.splice(toIdx, 0, movedItem);
            saveState();
            renderPhases();
            updateSchedule();
        });
    });
}

function renderSchedule() {
    if (!resultContainerEl) return;
    const schedule = calculateSchedule();
    const data = getActiveData();

    if (!schedule || !schedule.length) {
        resultContainerEl.innerHTML = '<div style="padding:2rem;text-align:center;">設定を確認してください</div>';
        return;
    }

    let displayList = [...schedule];
    if (data.sortOrder === 'asc') {
        displayList.reverse();
    }

    const sortBtn = document.getElementById('sort-toggle-btn');
    if (sortBtn) {
        const arrow = data.sortOrder === 'asc' ? '⬇️' : '⬆️';
        const label = data.sortOrder === 'asc' ? '昇順' : '降順';
        sortBtn.innerHTML = `<span>${label} ${arrow}</span>`;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:1.5rem; padding-top:1rem;">';
    displayList.forEach(item => {
        const isAnchor = item.id === data.anchorPhaseId;
        const highlight = isAnchor ? `border-left-color: var(--accent-primary); background: rgba(56, 189, 248, 0.05);` : '';
        const WORKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
        const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()} (${WORKDAYS_JA[d.getDay()]})`;

        html += `
      <div class="timeline-item" style="${highlight}">
        <div style="display:flex; justify-content:space-between; align-items:flex-end;">
            <div>
                <div class="timeline-title">${item.name}</div>
                <div class="timeline-subtitle">${item.days} 営業日</div>
            </div>
            <div style="text-align:right;">
                <div class="timeline-date" style="font-size:0.9rem; color:var(--text-primary);">
                   ${fmt(item.startDate)} - ${fmt(item.endDate)}
                </div>
            </div>
        </div>
      </div>`;
    });
    html += '</div>';
    resultContainerEl.innerHTML = html;
}

// --- Gantt Chart Logic ---

function renderGantt() {
    const container = document.getElementById('gantt-container');
    if (!container) return;

    // Clear previous
    container.innerHTML = '';

    // Collect all schedules
    const allSchedules = [];
    appState.timelines.forEach(t => {
        const sch = calculateSchedule(t.data);
        if (sch && sch.length > 0) {
            allSchedules.push({
                info: t,
                items: sch
            });
        }
    });

    if (allSchedules.length === 0) {
        container.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-secondary);">No schedule data</div>';
        return;
    }

    // 1. Determine Global Date Range
    let minDate = new Date(allSchedules[0].items[0].startDate);
    let maxDate = new Date(allSchedules[0].items[0].endDate);

    allSchedules.forEach(group => {
        group.items.forEach(p => {
            if (p.startDate < minDate) minDate = new Date(p.startDate);
            if (p.endDate > maxDate) maxDate = new Date(p.endDate);
        });
    });

    // Add buffer
    minDate.setDate(minDate.getDate() - 3);
    maxDate.setDate(maxDate.getDate() + 3);

    // 2. Constants
    const PX_PER_DAY = 30;
    const totalDays = Math.floor((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;
    const totalWidth = totalDays * PX_PER_DAY;

    // --- WRAPPER ---
    // Create a canvas wrapper to hold everything. This ensures correct scrolling.
    const canvas = document.createElement('div');
    canvas.style.width = `${totalWidth}px`;
    canvas.style.position = 'relative'; // Anchor for absolute grid lines
    canvas.style.minHeight = '100px';

    // 3. Create Header Row
    const headerRow = document.createElement('div');
    headerRow.className = 'gantt-header';
    headerRow.style.width = '100%'; // Match canvas

    let currentDate = new Date(minDate);
    const gridCols = [];

    for (let i = 0; i < totalDays; i++) {
        const cell = document.createElement('div');
        cell.className = 'gantt-header-cell';
        cell.style.width = `${PX_PER_DAY}px`;

        const d = currentDate.getDate();
        const m = currentDate.getMonth() + 1;
        const w = currentDate.getDay(); // 0=Sun, 6=Sat

        let label = `${d}`;
        if (i === 0 || d === 1) label = `${m}/${d}`;

        cell.textContent = label;
        if (w === 0 || w === 6) {
            cell.style.backgroundColor = 'rgba(255,255,255,0.02)';
            cell.style.color = '#ef4444';
        }

        if (isHoliday(currentDate)) {
            cell.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
            cell.style.color = '#ef4444';
        }

        headerRow.appendChild(cell);

        gridCols.push({
            isWeekend: (w === 0 || w === 6),
            isHoliday: isHoliday(currentDate),
            left: i * PX_PER_DAY
        });

        currentDate.setDate(currentDate.getDate() + 1);
    }

    canvas.appendChild(headerRow);

    // 4. Create Rows (Groups)
    allSchedules.forEach(group => {
        // Group Header
        const groupHeader = document.createElement('div');
        groupHeader.className = 'gantt-row';
        groupHeader.style.width = '100%';
        groupHeader.style.background = 'rgba(0,0,0,0.2)';
        groupHeader.style.height = '30px';

        const groupLabel = document.createElement('div');
        groupLabel.style.padding = '0 1rem';
        groupLabel.style.fontWeight = 'bold';
        groupLabel.style.color = 'var(--text-primary)';
        groupLabel.textContent = `📂 ${group.info.name}`;

        groupHeader.appendChild(groupLabel);
        canvas.appendChild(groupHeader);

        // Sort items for display
        let displayList = [...group.items];
        if (group.info.data.sortOrder === 'asc') displayList.reverse();

        displayList.forEach(item => {
            const row = document.createElement('div');
            row.className = 'gantt-row';
            row.style.width = '100%';

            const startDiff = Math.floor((item.startDate - minDate) / (1000 * 60 * 60 * 24));
            const durationDays = getDaysDiff(item.startDate, item.endDate);

            const barLeft = startDiff * PX_PER_DAY;
            const barWidth = durationDays * PX_PER_DAY;

            const bar = document.createElement('div');
            bar.className = 'gantt-bar';
            bar.style.left = `${barLeft}px`;
            bar.style.width = `${Math.max(0, barWidth - 4)}px`;

            bar.textContent = item.name;
            bar.title = `${group.info.name} > ${item.name}\n${item.startDate.toLocaleDateString()} - ${item.endDate.toLocaleDateString()}\n(${item.days} days)`;

            if (item.id === group.info.data.anchorPhaseId) {
                bar.style.background = 'var(--accent-secondary)';
                bar.style.boxShadow = '0 0 10px var(--accent-secondary)';
            }

            // --- INTERACTIVE ATTRIBUTES ---
            bar.dataset.id = item.id;
            bar.dataset.timelineId = group.info.id;

            // RESIZE HANDLE
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.dataset.id = item.id;
            handle.dataset.timelineId = group.info.id;
            bar.appendChild(handle);

            row.appendChild(bar);
            canvas.appendChild(row);
        });
    });

    // 5. Global Grid Lines
    const gridOverlay = document.createElement('div');
    gridOverlay.className = 'gantt-grid-lines';
    gridOverlay.style.width = '100%';
    gridOverlay.style.height = '100%'; // Will fill relative parent (canvas)
    gridOverlay.style.zIndex = '0'; // Behind header and rows (rows have z context via relative)

    gridCols.forEach((col) => {
        const line = document.createElement('div');
        line.className = 'gantt-grid-line';
        line.style.width = `${PX_PER_DAY}px`;
        if (col.isWeekend) line.classList.add('gantt-weekend');
        if (col.isHoliday) line.classList.add('gantt-holiday');
        gridOverlay.appendChild(line);
    });

    // Prepend grid to canvas so it sits behind
    canvas.insertBefore(gridOverlay, canvas.firstChild);

    // Finally append canvas to scroll container
    container.appendChild(canvas);

    // ATTACH LISTENERS
    attachGanttListeners(container, PX_PER_DAY);
}

function getDaysDiff(d1, d2) {
    return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
}

function updateSchedule() {
    renderSchedule();
    renderGantt();
}

// --- Init & Top Level Listeners ---

function attachTimelineListeners() {
    if (timelineSelect) {
        timelineSelect.addEventListener('change', (e) => {
            appState.activeTimelineId = e.target.value;
            saveState();
            initUI(); // Full re-render needed
        });
    }

    if (addTimelineBtn) {
        addTimelineBtn.addEventListener('click', () => {
            const name = prompt("Enter new timeline name:", `Sprint ${appState.timelines.length + 1}`);
            if (!name) return;

            const newId = Date.now().toString();
            appState.timelines.push({
                id: newId,
                name: name,
                data: createDefaultTimelineData()
            });
            appState.activeTimelineId = newId;
            saveState();
            renderTimelineSelect();
            initUI();
        });
    }

    if (renameTimelineBtn) {
        renameTimelineBtn.addEventListener('click', () => {
            const active = getActiveTimeline();
            const newName = prompt("Rename timeline:", active.name);
            if (newName) {
                active.name = newName;
                saveState();
                renderTimelineSelect();
            }
        });
    }

    if (deleteTimelineBtn) {
        deleteTimelineBtn.addEventListener('click', () => {
            if (appState.timelines.length <= 1) {
                alert("Cannot delete the last timeline.");
                return;
            }
            if (!confirm(`Are you sure you want to delete "${getActiveTimeline().name}"?`)) return;

            appState.timelines = appState.timelines.filter(t => t.id !== appState.activeTimelineId);
            appState.activeTimelineId = appState.timelines[0].id;
            saveState();
            initUI();
        });
    }
}

function attachTopListeners() {
    if (anchorPhaseSelect) {
        anchorPhaseSelect.addEventListener('change', (e) => {
            const data = getActiveData();
            data.anchorPhaseId = e.target.value;
            saveState();
            renderPhases();
            updateSchedule();
        });
    }

    if (anchorTypeRadios) {
        const newRadios = [];
        anchorTypeRadios.forEach(radio => {
            const fresh = replaceWithClone(radio);
            fresh.addEventListener('change', (e) => {
                const data = getActiveData();
                data.anchorType = e.target.value;
                saveState();
                renderPhases();
                updateSchedule();
            });
            newRadios.push(fresh);
        });
        anchorTypeRadios = newRadios;
    }

    if (document.getElementById('add-phase-btn')) {
        replaceWithClone(document.getElementById('add-phase-btn')).addEventListener('click', () => {
            const data = getActiveData();
            data.phases.push({ id: Date.now().toString(), name: 'New Phase', days: 5 });
            saveState();
            renderPhases();
            updateSchedule();
        });
    }

    if (anchorDateInput) {
        replaceWithClone(anchorDateInput).addEventListener('change', (e) => {
            const data = getActiveData();
            data.anchorDate = e.target.value;
            saveState();
            updateSchedule();
        });
        anchorDateInput = document.getElementById('anchor-date-input'); // Re-fetch ref
    }

    // Global Holidays Listener
    if (holidaysInput) {
        replaceWithClone(holidaysInput).addEventListener('change', (e) => {
            const text = e.target.value;
            appState.globalHolidays = text.split('\n').map(l => l.trim()).filter(l => l.match(/^\d{4}-\d{2}-\d{2}$/));
            saveState();
            updateSchedule(); // Re-calc all (active)
        });
        holidaysInput = document.getElementById('holidays-input');
    }

    const sortBtn = document.getElementById('sort-toggle-btn');
    if (sortBtn) {
        replaceWithClone(sortBtn).addEventListener('click', () => {
            const data = getActiveData();
            data.sortOrder = data.sortOrder === 'asc' ? 'desc' : 'asc';
            saveState();
            updateSchedule();
        });
    }

    const copyBtn = document.getElementById('copy-text-btn');
    if (copyBtn) {
        replaceWithClone(copyBtn).addEventListener('click', () => {
            const schedule = calculateSchedule();
            if (!schedule) return;
            const data = getActiveData();
            let list = [...schedule];
            if (data.sortOrder === 'asc') list.reverse();

            const SEPARATOR = "　";
            let text = `工程名${SEPARATOR}開始日${SEPARATOR}終了日${SEPARATOR}（営業日）\n`;
            const fmt = (d) => {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const d_str = String(d.getDate()).padStart(2, '0');
                return `${y}/${m}/${d_str}`;
            };
            list.forEach(item => {
                text += `${item.name}${SEPARATOR}${fmt(item.startDate)}${SEPARATOR}${fmt(item.endDate)}${SEPARATOR}（${item.days}）\n`;
            });
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById('copy-text-btn');
                const originalText = btn.innerHTML;
                btn.textContent = "✅ Copied!";
                setTimeout(() => { btn.innerHTML = originalText; }, 2000);
            }).catch(err => { alert('コピーに失敗しました'); });
        });
    }

    // Header Buttons
    const settingsBtn = document.getElementById('settings-toggle-btn');
    if (settingsBtn) {
        replaceWithClone(settingsBtn).addEventListener('click', () => {
            const panel = document.getElementById('global-settings-panel');
            if (panel) {
                const isHidden = panel.style.display === 'none';
                panel.style.display = isHidden ? 'block' : 'none';
            }
        });
    }

    if (document.getElementById('save-btn')) replaceWithClone(document.getElementById('save-btn')).addEventListener('click', exportJson);
    if (document.getElementById('load-btn')) replaceWithClone(document.getElementById('load-btn')).addEventListener('click', () => {
        document.getElementById('file-input').click();
    });
    if (document.getElementById('file-input')) replaceWithClone(document.getElementById('file-input')).addEventListener('change', (e) => {
        if (e.target.files[0]) importJson(e.target.files[0]);
    });
}

function replaceWithClone(node) {
    if (!node) return null;
    const clone = node.cloneNode(true);
    node.parentNode.replaceChild(clone, node);
    return clone;
}

function initUI() {
    loadState();
    bindDOMElements(); // Refresh refs

    const data = getActiveData();

    // Inputs value setting. Note: Listeners are attached in attachTopListeners via replaceWithClone
    // So we just set values here.

    if (anchorDateInput) anchorDateInput.value = data.anchorDate || '';
    if (holidaysInput) holidaysInput.value = (appState.globalHolidays || []).join('\n'); // Global!

    if (anchorTypeRadios) {
        anchorTypeRadios.forEach(radio => {
            radio.checked = radio.value === data.anchorType;
        });
    }

    renderTimelineSelect();
    renderPhases();
    updateSchedule();

    // Important: replaceWithClone in attachTopListeners will wipe values if we are not careful?
    // No, cloneNode(true) copies attributes and values (usually). 
    // Wait, cloneNode DOES NOT copy input values that were changed by user? 
    // It copies attributes. but 'value' property...
    // Actually, safer to bind listeners first? Or set values after replace?

    // Let's attach listeners (which does replacement), then set values again to be safe.
    attachTimelineListeners(); // These are persistent UI
    attachTopListeners();

    // Re-set values after replacement
    const newAnchorDate = document.getElementById('anchor-date-input');
    if (newAnchorDate) newAnchorDate.value = data.anchorDate || '';

    const newHolidays = document.getElementById('holidays-input');
    if (newHolidays) newHolidays.value = (appState.globalHolidays || []).join('\n');
}

// Start
document.addEventListener('DOMContentLoaded', () => {
    // initUI handles loading
    initUI();
});

// JSON IO
function exportJson() {
    const data = JSON.stringify(appState, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedule-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
}

function importJson(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            // Heuristic check
            if (data.timelines) { // V2 or V3
                appState = data;
                // v2 -> v3 migration check
                if (!appState.globalHolidays) appState.globalHolidays = [];
                saveState();
                initUI();
            } else if (data.phases) { // V1
                if (confirm("Older format detected. Import as a new timeline?")) {
                    const newId = Date.now().toString();
                    appState.timelines.push({
                        id: newId,
                        name: "Imported Timeline",
                        data: data
                    });
                    appState.activeTimelineId = newId;
                    saveState();
                    initUI();
                }
            } else {
                alert('Invalid JSON format');
            }
        } catch (err) {
            alert('Error parsing JSON');
        }
    };
    reader.readAsText(file);
}

// --- INTERACTIVE GANTT STATE & LISTENERS ---
let ganttDragState = {
    active: false,
    type: null, // 'move' | 'resize'
    startX: 0,
    initialLeft: 0,
    initialWidth: 0,
    phaseId: null,
    timelineId: null,
    initialDate: null, // For move
    initialDays: 0,    // For resize
    targetBar: null
};

function attachGanttListeners(container, pxPerDay) {
    if (container.dataset.listening) return;
    container.dataset.listening = 'true';

    container.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.resize-handle');
        const bar = e.target.closest('.gantt-bar');

        if (handle) {
            e.preventDefault();
            e.stopPropagation();
            startDrag(e, 'resize', handle.parentElement, handle.dataset.id, handle.dataset.timelineId);
        } else if (bar) {
            e.preventDefault();
            startDrag(e, 'move', bar, bar.dataset.id, bar.dataset.timelineId);
        }
    });

    const onMouseMove = (e) => {
        if (!ganttDragState.active) return;

        const deltaX = e.clientX - ganttDragState.startX;

        if (ganttDragState.type === 'move') {
            ganttDragState.targetBar.style.transform = `translateX(${deltaX}px)`;
        } else if (ganttDragState.type === 'resize') {
            const newW = Math.max(pxPerDay, ganttDragState.initialWidth + deltaX);
            ganttDragState.targetBar.style.width = `${newW}px`;
        }
    };

    const onMouseUp = (e) => {
        if (!ganttDragState.active) return;

        const deltaX = e.clientX - ganttDragState.startX;
        const deltaDays = Math.round(deltaX / pxPerDay);

        applyGanttChange(deltaDays);

        ganttDragState.active = false;
        if (ganttDragState.targetBar) {
            ganttDragState.targetBar.style.transform = ''; // Clear visual override
            ganttDragState.targetBar.classList.remove('dragging');
            ganttDragState.targetBar.classList.remove('active-drag');
            ganttDragState.targetBar = null;
        }

        document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function startDrag(e, type, bar, phaseId, timelineId) {
    ganttDragState.active = true;
    ganttDragState.type = type;
    ganttDragState.startX = e.clientX;
    ganttDragState.targetBar = bar;
    ganttDragState.phaseId = phaseId;
    ganttDragState.timelineId = timelineId;

    const rect = bar.getBoundingClientRect();
    ganttDragState.initialWidth = rect.width;

    // Find Data
    const timeline = appState.timelines.find(t => t.id === timelineId);
    if (!timeline) return;

    const phase = timeline.data.phases.find(p => p.id === phaseId);
    if (!phase) return;

    ganttDragState.initialDays = phase.days;

    bar.classList.add('dragging');
    bar.classList.add('active-drag'); // For z-index boost
    document.body.style.cursor = type === 'move' ? 'grabbing' : 'col-resize';
}

function applyGanttChange(deltaDays) {
    if (deltaDays === 0) return; // No change

    const { type, phaseId, timelineId, initialDays } = ganttDragState;
    const timeline = appState.timelines.find(t => t.id === timelineId);
    if (!timeline) return;
    const data = timeline.data;
    const phase = data.phases.find(p => p.id === phaseId);
    if (!phase) return;

    if (type === 'resize') {
        const newDays = initialDays + deltaDays;
        phase.days = Math.max(1, newDays);

        if (phase.isParallel) {
            const iso = (d) => {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            };

            const startStr = phase.manualStartDate || timeline.data.anchorDate; // Fallback
            // Fix: calculate new end date.
            // Simplified approach: Start + Days (Business days logic is tricky without proper calendar context here)
            // But we have getDaysDiff... let's assume calendar days for resize for parallel now for simplicity
            // OR re-use addBusinessDays if available?
            // Since parallel logic is manual, let's just update end date strictly.
            // Wait, if it's parallel, "days" is derived from dates.
            // If I change days, I should change End Date.

            const start = new Date(startStr);
            const end = new Date(startStr);
            // We want end date such that getDaysDiff(start, end) ~= newDays.
            // Approximate since we don't have easy business day add function handy here (it's inside calculateSchedule usually?)
            // Actually, let's just add NEWDAYS * 1.4 (weekend buffer) and refine? No.

            // Let's just update the manualEndDate to start + newDays (calendar days) for now?
            // No, that breaks business day logic.
            // Let's accept that for Parallel tasks, dragging resize handle changes "Days" property
            // and we calculate new EndDate as Start + Days (calendar) for now.

            end.setDate(end.getDate() + newDays);
            phase.manualEndDate = iso(end);
        }

    } else if (type === 'move') {
        const iso = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        // Is Anchor?
        if (phase.id === data.anchorPhaseId) {
            const currentAnchor = new Date(data.anchorDate);
            currentAnchor.setDate(currentAnchor.getDate() + deltaDays);
            data.anchorDate = iso(currentAnchor);

        } else {
            // Normal Phase (Collision-Aware Move)

            // 1. Determine Proposed Position without modifying state yet
            let tempStart, tempEnd;
            let currentIsParallel = phase.isParallel;

            // Determine base dates from CURRENT state
            if (currentIsParallel && phase.manualStartDate) {
                tempStart = new Date(phase.manualStartDate);
                tempEnd = new Date(phase.manualEndDate);
            } else {
                // Currently sequential. Use calculated position.
                const sch = calculateSchedule(data);
                const item = sch.find(i => i.id === phaseId);
                if (item) {
                    tempStart = new Date(item.startDate);
                    tempEnd = new Date(item.endDate);
                } else {
                    tempStart = new Date(data.anchorDate);
                    tempEnd = new Date(data.anchorDate);
                }
            }

            // Apply Move Delta to temp dates
            const proposedStart = new Date(tempStart);
            const proposedEnd = new Date(tempEnd);
            proposedStart.setDate(proposedStart.getDate() + deltaDays);
            proposedEnd.setDate(proposedEnd.getDate() + deltaDays);

            // 2. Collision Check
            // Check against CURRENT positions of all other tasks.
            const currentSchedule = calculateSchedule(data);

            const hasCollision = currentSchedule.some(otherItem => {
                if (otherItem.id === phaseId) return false; // Skip self

                // Check overlap only with Sequential (!isParallel) tasks
                const otherPhase = data.phases.find(p => p.id === otherItem.id);
                if (!otherPhase || otherPhase.isParallel) return false;
                if (otherPhase.id === data.anchorPhaseId) return false;

                // Check Overlap
                const s1 = proposedStart.getTime();
                const e1 = proposedEnd.getTime();
                const s2 = otherItem.startDate.getTime();
                const e2 = otherItem.endDate.getTime();

                return (s1 <= e2 && e1 >= s2);
            });

            if (hasCollision) {
                // Collision! Abort move.
                renderGantt(); // Snap back
                return;
            }

            // 3. Apply Change
            if (!phase.isParallel) {
                phase.isParallel = true;
                phase.manualStartDate = iso(tempStart);
                phase.manualEndDate = iso(tempEnd);
            }

            phase.manualStartDate = iso(proposedStart);
            phase.manualEndDate = iso(proposedEnd);
        }
    }

    saveState();
    renderPhases();
    updateSchedule();
}
