// Sarah Time Dashboard - Client Frontend App Logic

let state = {
  currentTab: 'dashboard',
  selectedDate: getTodayDhakaDate(),
  stats: null,
  employees: [],
  attendanceLogs: [],
  officeSettings: null,
  dateOverrides: [],
  dashboardDate: null,
  settingsLoaded: false,
  buildInfo: null,
  map: null,
  mapMarker: null,
  mapCircle: null
};

// Helper: Today's Date in Dhaka format (YYYY-MM-DD)
function getTodayDhakaDate() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  loadBuildInfo();
  loadDashboardData();
});

function initUI() {
  // Set default date input value
  const dateInput = document.getElementById('selectedDate');
  dateInput.value = state.selectedDate;

  dateInput.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    state.dashboardDate = null;
    if (state.currentTab === 'dashboard' || state.currentTab === 'attendance') {
      loadDashboardData();
    }
  });

  // Expose navigateDate globally for prev/next buttons
  window.navigateDate = function(direction) {
    const current = new Date(state.selectedDate + 'T00:00:00');
    current.setDate(current.getDate() + direction);
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const newDate = `${yyyy}-${mm}-${dd}`;
    state.selectedDate = newDate;
    document.getElementById('selectedDate').value = newDate;
    state.dashboardDate = null;
    if (state.currentTab === 'dashboard' || state.currentTab === 'attendance') {
      loadDashboardData();
    }
  };

  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (state.currentTab === 'settings') {
      fetchSettings({ force: true });
    } else if (state.currentTab === 'notifications') {
      loadNotificationsData({ force: true });
    } else {
      loadDashboardData({ force: true });
    }
  });

  // Tab Navigation Setup
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabName = item.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  // Search & Filter listeners
  document.getElementById('dashSearchInput').addEventListener('input', renderDashSummary);
  document.getElementById('attSearchInput').addEventListener('input', renderAttendanceLogs);
  document.getElementById('attStatusFilter').addEventListener('change', renderAttendanceLogs);
  document.getElementById('empSearchInput').addEventListener('input', renderEmployeeDirectory);

  // Forms Setup
  document.getElementById('officePolicyForm').addEventListener('submit', handlePolicySubmit);
  document.getElementById('dateOverrideForm').addEventListener('submit', handleOverrideSubmit);
  
  document.getElementById('employeeEditForm').addEventListener('submit', handleEmployeeUpdate);
  document.getElementById('btnDeleteEmployee').addEventListener('click', handleEmployeeDelete);
  
  document.getElementById('btnEditEmployeeToggle').addEventListener('click', toggleEmployeeEditMode);

  const buildInfoTrigger = document.getElementById('buildInfoTrigger');
  const buildInfoModal = document.getElementById('buildInfoModal');
  buildInfoTrigger?.addEventListener('click', openBuildInfoModal);
  document.getElementById('closeBuildInfoBtn')?.addEventListener('click', closeBuildInfoModal);
  document.getElementById('dismissBuildInfoBtn')?.addEventListener('click', closeBuildInfoModal);
  document.getElementById('copyBuildInfoBtn')?.addEventListener('click', copyBuildInfo);
  buildInfoModal?.addEventListener('click', event => {
    if (event.target === buildInfoModal) closeBuildInfoModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && buildInfoModal?.classList.contains('active')) {
      closeBuildInfoModal();
    }
  });
  
  document.getElementById('editAttendanceForm').addEventListener('submit', handleAttendanceEditSubmit);
  
  document.getElementById('empAttMonthPicker').addEventListener('change', (e) => {
    const empId = document.getElementById('editEmpUid').value;
    if (empId) loadEmployeeAttendance(empId, e.target.value);
  });

  initNotifications();

  // Theme Toggle
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    // Load saved theme
    const savedTheme = localStorage.getItem('appTheme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    themeBtn.addEventListener('click', () => {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      const newTheme = isLight ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('appTheme', newTheme);
    });
  }
}

function normalizeBuildInfo(data = {}) {
  const valueOr = (value, fallback) => (
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  );

  return {
    version: valueOr(data.version, '1.0.0'),
    buildNumber: valueOr(data.buildNumber, 'unavailable'),
    commit: valueOr(data.commit, 'unavailable'),
    environment: valueOr(data.environment, 'development'),
    deployedAt: valueOr(data.deployedAt, '')
  };
}

function formatBuildDate(isoDate) {
  if (!isoDate) return 'Unavailable';

  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date);
}

function renderBuildInfo(buildInfo) {
  const displayValue = value => value === 'unavailable' ? 'Unavailable' : value;
  const environment = buildInfo.environment.charAt(0).toUpperCase() + buildInfo.environment.slice(1);

  document.getElementById('appVersion').textContent = `v${buildInfo.version}`;
  document.getElementById('appBuildNumber').textContent = `Build ${displayValue(buildInfo.buildNumber)}`;
  document.getElementById('buildVersionDetail').textContent = buildInfo.version;
  document.getElementById('buildNumberDetail').textContent = displayValue(buildInfo.buildNumber);
  document.getElementById('buildCommitDetail').textContent = displayValue(buildInfo.commit);
  document.getElementById('buildEnvironmentDetail').textContent = environment;
  document.getElementById('buildDeployedAtDetail').textContent = formatBuildDate(buildInfo.deployedAt);
}

async function loadBuildInfo() {
  try {
    const response = await fetch('/version', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Version request failed with ${response.status}`);
    state.buildInfo = normalizeBuildInfo(await response.json());
  } catch (error) {
    console.warn('Build information is unavailable:', error);
    state.buildInfo = normalizeBuildInfo();
  }

  renderBuildInfo(state.buildInfo);
}

function openBuildInfoModal() {
  const modal = document.getElementById('buildInfoModal');
  if (!modal) return;

  modal.style.display = 'flex';
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('closeBuildInfoBtn')?.focus();
}

function closeBuildInfoModal() {
  const modal = document.getElementById('buildInfoModal');
  if (!modal) return;

  modal.classList.remove('active');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  document.getElementById('buildInfoTrigger')?.focus();
}

async function copyBuildInfo() {
  const buildInfo = state.buildInfo || normalizeBuildInfo();
  const summary = [
    `Version: ${buildInfo.version}`,
    `Build: ${buildInfo.buildNumber}`,
    `Commit: ${buildInfo.commit}`,
    `Environment: ${buildInfo.environment}`,
    `Deployed at: ${formatBuildDate(buildInfo.deployedAt)} (Asia/Dhaka)`
  ].join('\n');
  const button = document.getElementById('copyBuildInfoBtn');

  try {
    await navigator.clipboard.writeText(summary);
    if (button) button.textContent = 'Copied';
  } catch (error) {
    console.warn('Could not copy build information:', error);
    if (button) button.textContent = 'Copy failed';
  }

  setTimeout(() => {
    if (button) button.textContent = 'Copy Build Info';
  }, 1600);
}

function switchTab(tabName) {
  state.currentTab = tabName;

  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${tabName}"]`)?.classList.add('active');

  document.querySelectorAll('.tab-page').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabName}`)?.classList.add('active');

  const titleMap = {
    dashboard: { title: 'Dashboard Overview', sub: "Today's live attendance statistics" },
    attendance: { title: 'Attendance Logs', sub: 'Comprehensive record of employee check-ins' },
    employees: { title: 'Employee Directory', sub: 'Manage registered employees and profiles' },
    notifications: { title: 'Push Notifications', sub: 'Send, schedule and review employee notifications' },
    settings: { title: 'Office & Policy Settings', sub: 'Configure geofencing and working hours' }
  };

  if (titleMap[tabName]) {
    document.getElementById('currentTabTitle').textContent = titleMap[tabName].title;
    document.getElementById('currentTabSub').textContent = titleMap[tabName].sub;
  }

  if (tabName === 'settings') {
    if (!state.settingsLoaded) {
      fetchSettings();
    } else {
      setTimeout(initOrUpdateMap, 200);
    }
  }

  if (tabName === 'notifications') {
    renderNotifRecipientSummary();
    loadNotificationsData();
  }

  if ((tabName === 'dashboard' || tabName === 'attendance') &&
      state.dashboardDate !== state.selectedDate) {
    loadDashboardData();
  }
}

function showLoader() {
  const loader = document.getElementById('globalLoader');
  if (loader) loader.style.display = 'flex';
}

function hideLoader() {
  const loader = document.getElementById('globalLoader');
  if (loader) loader.style.display = 'none';
}

function setBtnLoading(btnId, isLoading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  if (isLoading) {
    btn.classList.add('btn-loading');
  } else {
    btn.classList.remove('btn-loading');
  }
}

async function loadDashboardData({ force = false } = {}) {
  if (!force && state.dashboardDate === state.selectedDate) return;
  showLoader();
  try {
    const res = await fetch(`/api/dashboard?date=${state.selectedDate}`);
    const data = await res.json();
    if (data.success) {
      state.stats = data.stats;
      state.employees = data.employees;
      state.attendanceLogs = data.logs;
      state.officeSettings = data.officeSettings;
      state.dashboardDate = data.dateKey;
      renderStatsCards();
      renderDashSummary();
      renderEmployeeDirectory();
      renderAttendanceLogs();
      renderNotifRecipientSummary();
    } else {
      console.error('Dashboard request failed:', data.error);
    }
  } catch (err) {
    console.error('Error fetching dashboard:', err);
  } finally {
    hideLoader();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

// Renders the office-status notice. Any date override shows a notice — open or closed;
// only the open/closed value changes whether attendance tracking is enabled.
function renderOfficeNotice() {
  const notice = state.stats ? state.stats.notice : null;
  const banners = ['holidayBanner', 'attendanceBanner']
    .map(id => document.getElementById(id))
    .filter(Boolean);

  if (!notice) {
    banners.forEach(banner => { banner.style.display = 'none'; });
    const banner = document.getElementById('holidayBanner');
    if (state.stats.isHoliday || state.stats.holidayReason) {
      banner.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg> <span>Office Status: <strong>${state.stats.holidayReason || state.stats.holidayStatusText}</strong></span>`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
    return;
  }

  const icon = notice.type === 'open'
    ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>`
    : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>`;

  const detail = notice.reason && notice.reason !== notice.title
    ? ` &mdash; ${escapeHtml(notice.reason)}`
    : '';
  const attendanceNote = notice.attendanceEnabled
    ? 'Attendance tracking enabled'
    : 'Attendance tracking disabled';

  banners.forEach(banner => {
    banner.className = `holiday-banner ${notice.type === 'open' ? 'open' : 'closed'}`;
    banner.innerHTML = `${icon}<span>Office Status: <strong>${escapeHtml(notice.title)}</strong>${detail}<small class="banner-note">${attendanceNote}</small></span>`;
    banner.style.display = 'flex';
  });
}

function renderStatsCards() {
  if (!state.stats) return;

  renderOfficeNotice();

  document.getElementById('statTotalEmployees').textContent = state.stats.activeEmployees;
  document.getElementById('statPresent').textContent = state.stats.presentCount;
  document.getElementById('statLate').textContent = state.stats.lateCount;
  document.getElementById('statAbsent').textContent = state.stats.absentCount;
}

async function fetchSettings({ force = false } = {}) {
  if (!force && state.settingsLoaded) return;
  showLoader();
  try {
    const res = await fetch('/api/settings/office');
    const data = await res.json();
    if (data.success) {
      state.officeSettings = data.settings;
      state.dateOverrides = data.dateOverrides;
      state.settingsLoaded = true;
      populateSettingsForm();
      renderDateOverrides();
      initOrUpdateMap();
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  } finally {
    hideLoader();
  }
}

function renderDashSummary() {
  const tbody = document.getElementById('dashSummaryTable');
  const query = document.getElementById('dashSearchInput').value.toLowerCase();

  const filtered = state.employees.filter(emp => {
    const name = (emp.profile.employeeName || emp.authEmail).toLowerCase();
    return name.includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No attendance records found for this date.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(emp => {
    const p = emp.profile || {};
    const att = emp.todayAttendance;
    const name = p.employeeName || emp.authEmail;
    const designation = p.designation || 'N/A';
    const initial = name.charAt(0).toUpperCase();

    let statusHtml = '<span class="badge absent">Absent</span>';
    let checkIn = '-';
    let checkOut = '-';
    let late = '0';

    if (att) {
      statusHtml = `<span class="badge ${att.status}">${att.status}</span>`;
      checkIn = att.checkInFormatted || 'Checked In';
      checkOut = att.checkOutFormatted || 'Pending';
      late = att.lateByMinutes || '0';
    }

    return `
      <tr>
        <td>
          <div class="user-cell">
            <div class="user-avatar">${initial}</div>
            <div>
              <div class="user-name">${name}</div>
              <div class="user-sub">${p.employeeId || emp.id}</div>
            </div>
          </div>
        </td>
        <td>${designation}</td>
        <td>${checkIn}</td>
        <td>${checkOut}</td>
        <td>${statusHtml}</td>
        <td>${late} mins</td>
        <td>
          <button class="btn-icon" onclick="openEditAttendanceModal('${emp.id}')" title="Edit Attendance">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderAttendanceLogs() {
  const tbody = document.getElementById('fullAttendanceTable');
  const query = document.getElementById('attSearchInput').value.toLowerCase();
  const statusFilter = document.getElementById('attStatusFilter').value;

  const filtered = state.attendanceLogs.filter(log => {
    const matchesSearch = log.employeeName.toLowerCase().includes(query) || log.employeeId.toLowerCase().includes(query);
    const matchesStatus = statusFilter === 'all' || log.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No records matching filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(log => {
    const locationText = log.checkInLocation?.address || 'N/A';
    return `
      <tr>
        <td>
          <div class="user-name">${log.employeeName}</div>
        </td>
        <td>${log.employeeId}</td>
        <td>${log.department}</td>
        <td>${log.checkInAt}</td>
        <td>${log.checkOutAt}</td>
        <td><span class="badge ${log.status}">${log.status}</span></td>
        <td style="max-width:250px; font-size:12px; color:var(--text-muted);">${locationText}</td>
        <td>
          <button class="btn-icon" onclick="openEditAttendanceModal('${log.id}')" title="Edit Attendance">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderEmployeeDirectory() {
  const tbody = document.getElementById('employeeDirectoryTable');
  const query = document.getElementById('empSearchInput').value.toLowerCase();

  const filtered = state.employees.filter(emp => {
    const name = (emp.profile.employeeName || emp.authEmail).toLowerCase();
    const employeeId = (emp.profile.employeeId || emp.id).toLowerCase();
    return name.includes(query) || employeeId.includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No employees found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(emp => {
    const p = emp.profile || {};
    const name = p.employeeName || emp.authEmail;
    const initial = name.charAt(0).toUpperCase();

    return `
      <tr>
        <td>
          <div class="user-cell">
            <div class="user-avatar">${initial}</div>
            <div>
              <div class="user-name">${name}</div>
              <div class="user-sub">${p.designation || 'Employee'}</div>
            </div>
          </div>
        </td>
        <td>${p.employeeId || emp.id}</td>
        <td>${emp.authEmail}</td>
        <td>${p.department || 'N/A'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" ${emp.isActive ? 'checked' : ''} onchange="toggleEmployeeActive('${emp.id}', this.checked)">
            <span class="slider"></span>
          </label>
        </td>
        <td>
          <button class="btn-secondary" style="padding:4px 12px; font-size:12px;" onclick="viewEmployeeProfile('${emp.id}')">View Profile</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function toggleEmployeeActive(empId, isChecked) {
  try {
    const res = await fetch(`/api/employees/${empId}/toggle-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: isChecked })
    });
    const data = await res.json();
    if (data.success) {
      await loadDashboardData({ force: true });
    }
  } catch (err) {
    console.error('Error toggling active state:', err);
  }
}

let isNewEmployee = false;

window.openAddEmployee = function() {
  isNewEmployee = true;
  document.getElementById('editEmpHeaderTitle').textContent = 'Add New Employee';
  document.getElementById('editEmpUid').value = '';

  const imgEl = document.getElementById('editEmpImage');
  imgEl.src = 'https://ui-avatars.com/api/?name=New+Employee&background=random';
  imgEl.style.display = 'inline-block';

  // Clear Form
  document.getElementById('editEmpName').value = '';
  document.getElementById('editEmpPhone').value = '';
  document.getElementById('editEmpPersonalEmail').value = '';
  document.getElementById('editEmpNid').value = '';
  document.getElementById('editEmpPresentAddress').value = '';
  document.getElementById('editEmpPermanentAddress').value = '';
  
  // Auto-generate employee ID
  let nextIdNum = 1;
  if (state.employees && state.employees.length > 0) {
    const ids = state.employees
      .map(e => {
        const idStr = e.profile?.employeeId || '';
        if (idStr.startsWith('ST')) {
          return parseInt(idStr.substring(2), 10) || 0;
        }
        return 0;
      })
      .filter(n => !isNaN(n));
    if (ids.length > 0) {
      nextIdNum = Math.max(...ids) + 1;
    }
  }
  document.getElementById('editEmpId').value = 'ST' + String(nextIdNum).padStart(3, '0');
  document.getElementById('editEmpDesignation').value = '';
  document.getElementById('editEmpDepartment').value = '';
  document.getElementById('editEmpType').value = 'Full-Time';
  document.getElementById('editEmpJoiningDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('editEmpOfficialEmail').value = '';
  document.getElementById('editEmpSalary').value = '';
  document.getElementById('editEmpEmergencyName').value = '';
  document.getElementById('editEmpEmergencyPhone').value = '';
  document.getElementById('editEmpEmergencyRelation').value = '';
  document.getElementById('editEmpBankAccount').value = '';

  setEmployeeEditMode(true);
  document.getElementById('btnDeleteEmployee').style.display = 'none'; // Hide delete button for new user
  document.getElementById('btnEditEmployeeToggle').style.display = 'none'; // Hide toggle
  switchTab('employee-edit');
}

window.viewEmployeeProfile = function(empId) {
  isNewEmployee = false;
  const emp = state.employees.find(e => e.id === empId);
  if (!emp) return;

  const p = emp.profile || {};
  document.getElementById('editEmpHeaderTitle').textContent = `Profile: ${p.employeeName || emp.authEmail || 'Employee'}`;
  document.getElementById('editEmpUid').value = emp.id;

  // Set Profile Image
  const imgEl = document.getElementById('editEmpImage');
  const imgUrl = p.photoUrl || emp.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.employeeName || emp.authEmail || 'User')}&background=random`;
  imgEl.src = imgUrl;
  imgEl.style.display = 'inline-block';

  // Personal Info
  document.getElementById('editEmpName').value = p.employeeName || '';
  document.getElementById('editEmpPhone').value = p.phoneNumber || '';
  document.getElementById('editEmpPersonalEmail').value = p.personalEmail || '';
  document.getElementById('editEmpNid').value = p.nidOrPassport || '';
  document.getElementById('editEmpPresentAddress').value = p.presentAddress || '';
  document.getElementById('editEmpPermanentAddress').value = p.permanentAddress || '';

  // Job Info
  document.getElementById('editEmpId').value = p.employeeId || '';
  document.getElementById('editEmpDesignation').value = p.designation || '';
  document.getElementById('editEmpDepartment').value = p.department || '';
  document.getElementById('editEmpType').value = p.employmentType || '';
  document.getElementById('editEmpJoiningDate').value = p.joiningDate || '';
  document.getElementById('editEmpOfficialEmail').value = p.officialEmail || emp.authEmail || '';
  document.getElementById('editEmpSalary').value = p.salary || '';

  // Emergency & Bank
  document.getElementById('editEmpEmergencyName').value = p.emergencyContactName || '';
  document.getElementById('editEmpEmergencyPhone').value = p.emergencyContactNumber || '';
  document.getElementById('editEmpEmergencyRelation').value = p.emergencyContactRelationship || '';
  document.getElementById('editEmpBankAccount').value = p.bankAccount || '';

  document.getElementById('btnDeleteEmployee').style.display = 'inline-block';
  document.getElementById('btnEditEmployeeToggle').style.display = 'inline-block';

  setEmployeeEditMode(false);
  switchTab('employee-edit');
  
  // Load Attendance
  document.getElementById('empAttendanceSection').style.display = 'block';
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('empAttMonthPicker').value = currentMonth;
  loadEmployeeAttendance(empId, currentMonth);
}

let isEmployeeEditMode = false;
function setEmployeeEditMode(isEdit) {
  isEmployeeEditMode = isEdit;
  const form = document.getElementById('employeeEditForm');
  const inputs = form.querySelectorAll('input');
  
  inputs.forEach(input => {
    if (input.type !== 'hidden') {
      let shouldBeReadOnly = !isEdit;
      
      if (input.id === 'editEmpId') {
        shouldBeReadOnly = true; // Never edit employee ID
      }
      
      if (input.id === 'editEmpPersonalEmail' && !isNewEmployee) {
        shouldBeReadOnly = true; // Personal email cannot be edited after creation
      }

      input.readOnly = shouldBeReadOnly;
      if (shouldBeReadOnly) {
        input.style.backgroundColor = 'var(--input-readonly)';
        input.style.border = '1px solid transparent';
      } else {
        input.style.backgroundColor = 'var(--input-bg)';
        input.style.border = '1px solid var(--border-color)';
      }
    }
  });

  const btnSave = document.getElementById('btnSaveEmployee');
  btnSave.style.display = isEdit ? 'inline-flex' : 'none';
  
  const btnToggle = document.getElementById('btnEditEmployeeToggle');
  btnToggle.textContent = isEdit ? 'Cancel Edit' : 'Edit Profile';
}

function toggleEmployeeEditMode() {
  setEmployeeEditMode(!isEmployeeEditMode);
}

async function handleEmployeeUpdate(e) {
  e.preventDefault();
  const empId = document.getElementById('editEmpUid').value;
  if (!isNewEmployee && !empId) return;

  setBtnLoading('btnSaveEmployee', true);

  const payload = {
    employeeName: document.getElementById('editEmpName').value,
    phoneNumber: document.getElementById('editEmpPhone').value,
    personalEmail: document.getElementById('editEmpPersonalEmail').value,
    nidOrPassport: document.getElementById('editEmpNid').value,
    presentAddress: document.getElementById('editEmpPresentAddress').value,
    permanentAddress: document.getElementById('editEmpPermanentAddress').value,
    
    employeeId: document.getElementById('editEmpId').value,
    designation: document.getElementById('editEmpDesignation').value,
    department: document.getElementById('editEmpDepartment').value,
    employmentType: document.getElementById('editEmpType').value,
    joiningDate: document.getElementById('editEmpJoiningDate').value,
    officialEmail: document.getElementById('editEmpOfficialEmail').value,
    salary: document.getElementById('editEmpSalary').value,
    
    emergencyContactName: document.getElementById('editEmpEmergencyName').value,
    emergencyContactNumber: document.getElementById('editEmpEmergencyPhone').value,
    emergencyContactRelationship: document.getElementById('editEmpEmergencyRelation').value,
    bankAccount: document.getElementById('editEmpBankAccount').value,
  };

  try {
    const method = isNewEmployee ? 'POST' : 'PUT';
    const endpoint = isNewEmployee ? `/api/employees` : `/api/employees/${empId}`;
    
    const res = await fetch(endpoint, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert(isNewEmployee ? 'Employee added successfully with default password "123456"' : 'Employee details updated successfully.');
      await loadDashboardData({ force: true });
      switchTab('employees');
    } else {
      alert('Failed to save: ' + data.error);
    }
  } catch (err) {
    console.error('Save error:', err);
    alert('An error occurred while saving.');
  } finally {
    setBtnLoading('btnSaveEmployee', false);
  }
}

async function handleEmployeeDelete() {
  const empId = document.getElementById('editEmpUid').value;
  if (!empId) return;

  if (!confirm('Are you sure you want to completely delete this employee? This cannot be undone.')) {
    return;
  }
  
  setBtnLoading('btnDeleteEmployee', true);

  try {
    const res = await fetch(`/api/employees/${empId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      alert('Employee deleted successfully.');
      await loadDashboardData({ force: true });
      switchTab('employees');
    } else {
      alert('Failed to delete: ' + data.error);
    }
  } catch (err) {
    console.error('Delete error:', err);
    alert('An error occurred while deleting.');
  } finally {
    setBtnLoading('btnDeleteEmployee', false);
  }
}

function populateSettingsForm() {
  if (!state.officeSettings) return;
  const s = state.officeSettings;
  document.getElementById('settingLat').value = s.latitude || 23.7639;
  document.getElementById('settingLng').value = s.longitude || 90.4242;
  document.getElementById('settingRadius').value = s.allowedRadiusMeters || 100;
  document.getElementById('settingStart').value = s.startTimeLocal || '09:30';
  document.getElementById('settingEnd').value = s.endTimeLocal || '18:00';
  document.getElementById('settingLate').value = s.lateThresholdMinutes || 15;
  document.getElementById('settingCheckinOpen').value = s.checkInOpensBeforeMinutes || 30;

  // Load weeklyOfficeDays checkboxes
  const activeDays = Array.isArray(s.weeklyOfficeDays) ? s.weeklyOfficeDays.map(Number) : [1,2,3,4,5,6,7];
  [1,2,3,4,5,6,7].forEach(day => {
    const el = document.getElementById(`day${day}`);
    if (el) el.checked = activeDays.includes(day);
  });
}

function renderDateOverrides() {
  const tbody = document.getElementById('overrideTableBody');
  if (state.dateOverrides.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">No date overrides added yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.dateOverrides.map(item => `
    <tr>
      <td><strong>${item.dateKey}</strong></td>
      <td><span class="badge ${item.isOfficeOpen ? 'present' : 'absent'}">${item.isOfficeOpen ? 'Open' : 'Closed'}</span></td>
      <td style="font-size:13px;">${item.reason}</td>
      <td>
        <button class="btn-secondary" style="padding:4px 8px; color:var(--primary); margin-right:4px;" onclick="editDateOverride('${item.dateKey}')">Edit</button>
        <button class="btn-secondary" style="padding:4px 8px; color:var(--danger);" onclick="deleteDateOverride('${item.dateKey}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

async function handlePolicySubmit(e) {
  e.preventDefault();
  const payload = {
    latitude: document.getElementById('settingLat').value,
    longitude: document.getElementById('settingLng').value,
    allowedRadiusMeters: document.getElementById('settingRadius').value,
    startTimeLocal: document.getElementById('settingStart').value,
    endTimeLocal: document.getElementById('settingEnd').value,
    lateThresholdMinutes: document.getElementById('settingLate').value,
    checkInOpensBeforeMinutes: document.getElementById('settingCheckinOpen').value,
    weeklyOfficeDays: [1,2,3,4,5,6,7].filter(day => {
      const el = document.getElementById(`day${day}`);
      return el && el.checked;
    })
  };

  try {
    const res = await fetch('/api/settings/office', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      alert('Office policy updated successfully!');
      state.dashboardDate = null;
      fetchSettings({ force: true });
    }
  } catch (err) {
    console.error('Error saving policy:', err);
  }
}

async function handleOverrideSubmit(e) {
  e.preventDefault();
  const payload = {
    dateKey: document.getElementById('overrideDateKey').value,
    isOfficeOpen: document.getElementById('overrideStatus').value === 'true',
    reason: document.getElementById('overrideReason').value
  };

  try {
    const res = await fetch('/api/settings/date-override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('dateOverrideForm').reset();
      state.dashboardDate = null;
      fetchSettings({ force: true });
    }
  } catch (err) {
    console.error('Error adding override:', err);
  }
}

window.editDateOverride = function(dateKey) {
  const override = state.dateOverrides.find(o => o.dateKey === dateKey);
  if (!override) return;
  document.getElementById('overrideDateKey').value = override.dateKey;
  document.getElementById('overrideStatus').value = override.isOfficeOpen.toString();
  document.getElementById('overrideReason').value = override.reason;
}

async function deleteDateOverride(dateKey) {
  if (!confirm(`Remove override for ${dateKey}?`)) return;
  try {
    const res = await fetch(`/api/settings/date-override/${dateKey}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      state.dashboardDate = null;
      fetchSettings({ force: true });
    }
  } catch (err) {
    console.error('Error deleting override:', err);
  }
}

function initOrUpdateMap() {
  const mapEl = document.getElementById('map');
  if (!mapEl || !state.officeSettings) return;

  const lat = state.officeSettings.latitude || 23.7639;
  const lng = state.officeSettings.longitude || 90.4242;
  const radius = state.officeSettings.allowedRadiusMeters || 100;

  if (!state.map) {
    state.map = L.map('map').setView([lat, lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(state.map);

    state.mapMarker = L.marker([lat, lng]).addTo(state.map).bindPopup('Office Location');
    state.mapCircle = L.circle([lat, lng], {
      color: '#6366f1',
      fillColor: '#6366f1',
      fillOpacity: 0.25,
      radius: radius
    }).addTo(state.map);
  } else {
    state.map.setView([lat, lng], 16);
    state.mapMarker.setLatLng([lat, lng]);
    state.mapCircle.setLatLng([lat, lng]);
    state.mapCircle.setRadius(radius);
    state.map.invalidateSize();
  }
}

// Edit Attendance Logic
window.openEditAttendanceModal = function(empId) {
  // Find employee attendance log
  let att = null;
  const emp = state.employees.find(e => e.id === empId);
  if (emp && emp.todayAttendance) {
    att = emp.todayAttendance;
  } else {
    const log = state.attendanceLogs.find(l => l.id === empId);
    if (log) att = log;
  }
  
  document.getElementById('editAttEmpId').value = empId;
  document.getElementById('editAttDateKey').value = state.selectedDate;
  
  // Format to HH:mm for time input if value exists
  const formatTimeInput = (timeStr) => {
    if (!timeStr || timeStr === '-' || timeStr === 'Pending' || timeStr === 'N/A') return '';
    // timeStr could be like '08:17:20 AM' (with seconds) or '10:15 AM' (without)
    // Strip seconds: '08:17:20 AM' -> '08:17 AM'
    const normalized = timeStr.replace(/(\d+:\d+):\d+\s/, '$1 ');
    const parts = normalized.match(/(\d+):(\d+)\s(AM|PM)/i);
    if (parts) {
      let h = parseInt(parts[1]);
      let m = parts[2];
      let ampm = parts[3].toUpperCase();
      if (ampm === 'PM' && h < 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      return `${h.toString().padStart(2, '0')}:${m}`;
    }
    return '';
  };
  
  const checkInVal = att ? (att.checkInFormatted || att.checkInAt) : '';
  const checkOutVal = att ? (att.checkOutFormatted || att.checkOutAt) : '';
  
  document.getElementById('editAttCheckIn').value = formatTimeInput(checkInVal);
  document.getElementById('editAttCheckOut').value = formatTimeInput(checkOutVal);
  
  const modal = document.getElementById('editAttendanceModal');
  modal.style.display = 'flex';
  modal.classList.add('active');
};

window.closeEditAttendanceModal = function() {
  const modal = document.getElementById('editAttendanceModal');
  modal.classList.remove('active');
  modal.style.display = 'none';
};

async function handleAttendanceEditSubmit(e) {
  e.preventDefault();
  const empId = document.getElementById('editAttEmpId').value;
  const dateKey = document.getElementById('editAttDateKey').value;
  let checkIn = document.getElementById('editAttCheckIn').value;
  let checkOut = document.getElementById('editAttCheckOut').value;
  
  if (!checkIn) checkIn = '-';
  if (!checkOut) checkOut = '-';

  const btn = document.getElementById('btnSaveAttendance');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/attendance/edit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: empId,
        dateKey: dateKey,
        checkInTime: checkIn,
        checkOutTime: checkOut
      })
    });
    const data = await res.json();
    if (data.success) {
      closeEditAttendanceModal();
      loadDashboardData({ force: true });
    } else {
      alert('Failed to edit attendance: ' + data.error);
    }
  } catch (err) {
    console.error('Error editing attendance:', err);
    alert('An error occurred.');
  } finally {
    btn.textContent = 'Save Changes';
    btn.disabled = false;
  }
}

window.handleDeleteAttendance = async function() {
  const empId = document.getElementById('editAttEmpId').value;
  const dateKey = document.getElementById('editAttDateKey').value;

  if (!empId || !dateKey) {
    alert('Attendance data not found.');
    return;
  }

  const confirmed = confirm('Delete this attendance record? This can\'t be undone.');
  if (!confirmed) return;

  const btn = document.getElementById('btnDeleteAttendance');
  btn.textContent = 'Deleting...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/attendance/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: empId, dateKey })
    });
    const data = await res.json();
    if (data.success) {
      closeEditAttendanceModal();
      loadDashboardData({ force: true });
    } else {
      alert('Failed to delete: ' + data.error);
    }
  } catch (err) {
    console.error('Error deleting attendance:', err);
    alert('An error occurred.');
  } finally {
    btn.textContent = 'Delete Record';
    btn.disabled = false;
  }
}

// --- Employee Monthly Attendance ---
async function loadEmployeeAttendance(empId, month) {
  const tbody = document.getElementById('empAttTableBody');
  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>`;
  
  try {
    const res = await fetch(`/api/employees/${empId}/attendance?month=${month}`);
    const data = await res.json();
    
    if (data.success) {
      let totalPresent = 0;
      let totalLate = 0;
      let totalMinutesWorked = 0;
      
      if (data.records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No attendance records found for this month.</td></tr>`;
      } else {
        // Sort by date descending (latest first)
        data.records.sort((a, b) => b.dateKey.localeCompare(a.dateKey));
        
        tbody.innerHTML = data.records.map(record => {
          let checkInStr = 'N/A';
          let checkOutStr = 'N/A';
          let hoursWorkedStr = '-';
          
          if (record.checkInAt) {
            checkInStr = new Date(record.checkInAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          }
          if (record.checkOutAt) {
            checkOutStr = new Date(record.checkOutAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          }
          
          if (record.checkInAt && record.checkOutAt) {
            const diffMs = new Date(record.checkOutAt) - new Date(record.checkInAt);
            const diffMins = Math.floor(diffMs / 60000);
            totalMinutesWorked += diffMins;
            const h = Math.floor(diffMins / 60);
            const m = diffMins % 60;
            hoursWorkedStr = `${h}h ${m}m`;
          }
          
          if (record.status === 'present') totalPresent++;
          if (record.status === 'late') totalLate++;
          
          const statusHtml = record.status === 'present' 
            ? `<span class="badge present">Present</span>`
            : (record.status === 'late' ? `<span class="badge absent" style="background:rgba(245, 158, 11, 0.15); color:#f59e0b; border-color:rgba(245, 158, 11, 0.3);">Late</span>` : `<span class="badge absent">Unknown</span>`);
            
          return `
            <tr>
              <td><strong>${record.dateKey}</strong></td>
              <td>${checkInStr}</td>
              <td>${checkOutStr}</td>
              <td>${hoursWorkedStr}</td>
              <td>${statusHtml}</td>
              <td style="font-size:12px;">${record.location}</td>
            </tr>
          `;
        }).join('');
      }
      
      // Calculate total absent based on open days vs present+late
      // We can estimate open days up to today or end of month.
      // A simple approximation is 22 working days minus present/late.
      // Or we can just calculate what we know. Let's assume standard working days in the past.
      // But calculating exact absent days without iterating over the month and checking overrides is complex on frontend.
      // For now, let's just show a simplified calculation or omit it.
      // I'll calculate total working days in the month till today.
      
      const totalH = Math.floor(totalMinutesWorked / 60);
      const totalM = totalMinutesWorked % 60;
      
      document.getElementById('empAttTotalPresent').textContent = totalPresent;
      document.getElementById('empAttTotalLate').textContent = totalLate;
      document.getElementById('empAttTotalHours').textContent = `${totalH}h ${totalM}m`;
      
      // Rough absent estimation for the month (only up to current date if current month)
      const [y, m] = month.split('-');
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0); // last day of month
      const today = new Date();
      const calcEnd = (start.getMonth() === today.getMonth() && start.getFullYear() === today.getFullYear()) ? today : end;
      
      let workDays = 0;
      let d = new Date(start);
      // Active office days check
      const officeDays = state.officeSettings?.weeklyOfficeDays || [1,2,3,4,5,6,7];
      while (d <= calcEnd) {
        // JS Date.getDay() is 0=Sun, 1=Mon, ..., 6=Sat
        // Our settings: 1=Mon, ..., 7=Sun
        let jsDay = d.getDay();
        let sarahDay = jsDay === 0 ? 7 : jsDay;
        
        // Simple override check
        const dStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const override = state.dateOverrides.find(o => o.dateKey === dStr);
        
        let isOpen = false;
        if (override) {
          isOpen = override.isOfficeOpen;
        } else {
          isOpen = officeDays.includes(sarahDay);
        }
        
        if (isOpen) workDays++;
        d.setDate(d.getDate() + 1);
      }
      
      const totalAbsent = Math.max(0, workDays - (totalPresent + totalLate));
      document.getElementById('empAttTotalAbsent').textContent = totalAbsent;
      
    } else {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--danger);">${data.error}</td></tr>`;
    }
  } catch (err) {
    console.error('Failed to load employee attendance:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--danger);">Failed to load data.</td></tr>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
//
// Ported from the Text Bee dashboard's notification module
// (lib/presentation/pages/notification_management_page.dart +
// lib/data/services/notification_service.dart). Same three tabs, the same
// target / status / recurring vocabulary and the same API contract.
//
// Recipient search runs against `state.employees`, which the dashboard has
// already loaded, instead of Text Bee's server-side user search endpoint —
// this project has one employee directory in memory, so a second endpoint
// would only duplicate it.
// ═══════════════════════════════════════════════════════════════════════

const NOTIF_HISTORY_PAGE_SIZE = 20;

const notifState = {
  historyLogs: [],
  historyPage: 1,
  historyTotalCount: 0,
  historyHasMore: false,
  historySelection: new Set(),
  scheduled: [],
  scheduledSelection: new Set(),
  detailLogId: null,
  searchDebounce: null,
  loaded: false
};

// ─── Formatting helpers (mirror NotificationLogModel getters) ─────────

function notifTargetLabel(target) {
  return target === 'all_users' ? 'All Employees' : 'Selected Employees';
}

function notifStatusLabel(status) {
  const labels = { success: 'Sent', failed: 'Failed', pending: 'Scheduled', sent: 'Sent', cancelled: 'Cancelled' };
  return labels[status] || status;
}

function notifRecurringLabel(item) {
  if (!item.isRecurring) return 'One-time';
  const labels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  return labels[item.recurringType] || 'Recurring';
}

function notifDeliverySummary(log) {
  const total = (log.successCount || 0) + (log.failureCount || 0);
  if (total === 0) return '-';
  if (!log.failureCount) return `${log.successCount} sent`;
  return `${log.successCount}/${total} delivered`;
}

function formatNotifTimestamp(iso) {
  if (!iso) return 'N/A';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Dhaka',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function formatNotifTimeAgo(iso) {
  if (!iso) return 'N/A';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} days ago`;
  return formatNotifTimestamp(iso);
}

function notifBodyPreview(body) {
  const text = String(body || '');
  return text.length <= 60 ? text : `${text.slice(0, 60)}...`;
}

// `datetime-local` value for Dhaka wall-clock time, `minutesAhead` from now.
function getDhakaDateTimeLocal(minutesAhead = 0) {
  const target = new Date(Date.now() + minutesAhead * 60000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(target);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function employeeDisplayName(emp) {
  return (emp.profile && emp.profile.employeeName) || emp.authEmail || emp.id;
}

function employeeDisplayId(emp) {
  return (emp.profile && emp.profile.employeeId) || emp.id;
}

// ─── Recipient picker ─────────────────────────────────────────────────

// One picker instance per form (send tab + schedule modal). Both search the
// already-loaded employee directory and hold their own selection.
function createRecipientPicker(ids, onChange) {
  const picker = {
    selected: [],
    container: document.getElementById(ids.container),
    chipList: document.getElementById(ids.chipList),
    searchInput: document.getElementById(ids.search),
    results: document.getElementById(ids.results),
    clearBtn: document.getElementById(ids.clear),
    onChange: onChange || (() => {})
  };

  picker.uids = () => picker.selected.map(emp => emp.id);

  picker.renderChips = () => {
    picker.chipList.innerHTML = picker.selected.map(emp => {
      const name = employeeDisplayName(emp);
      return `
        <span class="chip">
          <span class="chip-avatar">${escapeHtml(name.charAt(0).toUpperCase())}</span>
          ${escapeHtml(name)}
          <button type="button" class="chip-remove" data-remove="${escapeHtml(emp.id)}" title="Remove">&times;</button>
        </span>
      `;
    }).join('');
    picker.onChange();
  };

  picker.renderResults = () => {
    const query = picker.searchInput.value.trim().toLowerCase();
    if (!query) {
      picker.results.innerHTML = '';
      return;
    }

    const selectedIds = new Set(picker.uids());
    const matches = state.employees
      .filter(emp => !selectedIds.has(emp.id))
      .filter(emp => {
        const haystack = [
          employeeDisplayName(emp),
          employeeDisplayId(emp),
          emp.authEmail || '',
          emp.profile?.officialEmail || ''
        ].join(' ').toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 8);

    if (matches.length === 0) {
      picker.results.innerHTML = `<div class="picker-empty">No employees found</div>`;
      return;
    }

    picker.results.innerHTML = matches.map(emp => {
      const name = employeeDisplayName(emp);
      const noDevice = !emp.hasFcmToken
        ? `<span class="badge failed" style="font-size:10px; padding:2px 8px;">No device</span>`
        : '';
      const inactive = !emp.isActive
        ? `<span class="badge inactive" style="font-size:10px; padding:2px 8px;">Inactive</span>`
        : '';
      return `
        <div class="picker-item" data-add="${escapeHtml(emp.id)}">
          <div class="user-avatar" style="width:28px; height:28px; font-size:12px;">${escapeHtml(name.charAt(0).toUpperCase())}</div>
          <div style="flex:1;">
            <div class="user-name" style="font-size:13px;">${escapeHtml(name)}</div>
            <div class="user-sub">${escapeHtml(employeeDisplayId(emp))} &bull; ${escapeHtml(emp.authEmail || '')}</div>
          </div>
          ${inactive}
          ${noDevice}
        </div>
      `;
    }).join('');
  };

  picker.add = empId => {
    if (picker.selected.some(emp => emp.id === empId)) return;
    const employee = state.employees.find(emp => emp.id === empId);
    if (!employee) return;
    picker.selected.push(employee);
    picker.searchInput.value = '';
    picker.results.innerHTML = '';
    picker.renderChips();
  };

  picker.remove = empId => {
    picker.selected = picker.selected.filter(emp => emp.id !== empId);
    picker.renderChips();
    picker.renderResults();
  };

  picker.clear = () => {
    picker.selected = [];
    picker.searchInput.value = '';
    picker.results.innerHTML = '';
    picker.renderChips();
  };

  picker.setVisible = visible => {
    picker.container.style.display = visible ? 'block' : 'none';
    if (!visible) picker.clear();
  };

  picker.searchInput.addEventListener('input', picker.renderResults);
  picker.results.addEventListener('click', event => {
    const item = event.target.closest('[data-add]');
    if (item) picker.add(item.getAttribute('data-add'));
  });
  picker.chipList.addEventListener('click', event => {
    const button = event.target.closest('[data-remove]');
    if (button) picker.remove(button.getAttribute('data-remove'));
  });
  picker.clearBtn.addEventListener('click', picker.clear);

  return picker;
}

let sendPicker = null;
let schedulePicker = null;

// ─── Init ─────────────────────────────────────────────────────────────

function initNotifications() {
  // Sub-tab switching
  document.querySelectorAll('.sub-tab').forEach(button => {
    button.addEventListener('click', () => switchNotifSubTab(button.getAttribute('data-subtab')));
  });

  sendPicker = createRecipientPicker({
    container: 'notifRecipientPicker',
    chipList: 'notifChipList',
    search: 'notifRecipientSearch',
    results: 'notifRecipientResults',
    clear: 'notifClearRecipients'
  }, renderNotifJsonPreview);

  schedulePicker = createRecipientPicker({
    container: 'scheduleRecipientPicker',
    chipList: 'scheduleChipList',
    search: 'scheduleRecipientSearch',
    results: 'scheduleRecipientResults',
    clear: 'scheduleClearRecipients'
  });

  // Target segments
  bindSegmentGroup('notifTargetGroup', 'target', value => {
    sendPicker.setVisible(value === 'selected_users');
    renderNotifJsonPreview();
  });
  bindSegmentGroup('scheduleTargetGroup', 'target', value => {
    schedulePicker.setVisible(value === 'selected_users');
  });
  bindSegmentGroup('scheduleRecurringType', 'recurring');

  // Send form
  ['notifTitle', 'notifBody', 'notifImageUrl', 'notifActionUrl'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderNotifJsonPreview);
  });
  document.getElementById('notifSendForm').addEventListener('submit', handleSendNotification);

  // History filters
  document.getElementById('notifHistorySearch').addEventListener('input', () => {
    clearTimeout(notifState.searchDebounce);
    notifState.searchDebounce = setTimeout(() => {
      notifState.historyPage = 1;
      fetchNotificationHistory();
    }, 400);
  });
  ['notifHistoryTarget', 'notifHistoryStatus', 'notifHistoryFrom', 'notifHistoryTo'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      notifState.historyPage = 1;
      fetchNotificationHistory();
    });
  });
  document.getElementById('notifHistoryReset').addEventListener('click', () => {
    document.getElementById('notifHistorySearch').value = '';
    document.getElementById('notifHistoryTarget').value = '';
    document.getElementById('notifHistoryStatus').value = '';
    document.getElementById('notifHistoryFrom').value = '';
    document.getElementById('notifHistoryTo').value = '';
    notifState.historyPage = 1;
    fetchNotificationHistory();
  });
  document.getElementById('notifHistoryPrev').addEventListener('click', () => {
    if (notifState.historyPage > 1) {
      notifState.historyPage--;
      fetchNotificationHistory();
    }
  });
  document.getElementById('notifHistoryNext').addEventListener('click', () => {
    if (notifState.historyHasMore) {
      notifState.historyPage++;
      fetchNotificationHistory();
    }
  });

  // History selection + delete
  document.getElementById('notifHistorySelectAll').addEventListener('change', event => {
    notifState.historySelection = event.target.checked
      ? new Set(notifState.historyLogs.map(log => log.id))
      : new Set();
    renderNotificationHistory();
  });
  document.getElementById('notifHistoryClearSelection').addEventListener('click', () => {
    notifState.historySelection = new Set();
    renderNotificationHistory();
  });
  document.getElementById('notifHistoryDelete').addEventListener('click', () => {
    deleteNotifications([...notifState.historySelection], 'notification_logs');
  });

  // Scheduled selection + delete
  document.getElementById('notifScheduledSelectAll').addEventListener('change', event => {
    notifState.scheduledSelection = event.target.checked
      ? new Set(notifState.scheduled.map(item => item.id))
      : new Set();
    renderScheduledNotifications();
  });
  document.getElementById('notifScheduledClearSelection').addEventListener('click', () => {
    notifState.scheduledSelection = new Set();
    renderScheduledNotifications();
  });
  document.getElementById('notifScheduledDelete').addEventListener('click', () => {
    deleteNotifications([...notifState.scheduledSelection], 'scheduled_notifications');
  });

  // Scheduling
  document.getElementById('btnOpenScheduleModal').addEventListener('click', openScheduleNotifModal);
  document.getElementById('scheduleNotifForm').addEventListener('submit', handleScheduleNotification);
  document.getElementById('scheduleRecurring').addEventListener('change', event => {
    document.getElementById('scheduleRecurringTypeGroup').style.display = event.target.checked ? 'flex' : 'none';
  });
  document.getElementById('btnRunScheduled').addEventListener('click', runDueScheduledNotifications);
  document.getElementById('btnDuplicateNotif').addEventListener('click', duplicateNotificationToSend);

  renderNotifJsonPreview();
}

function bindSegmentGroup(groupId, dataKey, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.addEventListener('click', event => {
    const segment = event.target.closest('.segment');
    if (!segment) return;
    group.querySelectorAll('.segment').forEach(el => el.classList.remove('active'));
    segment.classList.add('active');
    if (onChange) onChange(segment.getAttribute(`data-${dataKey}`));
  });
}

function getSegmentValue(groupId, dataKey) {
  const active = document.querySelector(`#${groupId} .segment.active`);
  return active ? active.getAttribute(`data-${dataKey}`) : null;
}

function switchNotifSubTab(subTabName) {
  document.querySelectorAll('.sub-tab').forEach(el => el.classList.remove('active'));
  document.querySelector(`.sub-tab[data-subtab="${subTabName}"]`)?.classList.add('active');
  document.querySelectorAll('.sub-tab-page').forEach(el => el.classList.remove('active'));
  document.getElementById(`subtab-${subTabName}`)?.classList.add('active');
}

async function loadNotificationsData({ force = false } = {}) {
  if (!force && notifState.loaded) return;
  await Promise.all([
    fetchNotificationHistory(),
    fetchScheduledNotifications()
  ]);
  notifState.loaded = true;
}

// Shows how many employees a broadcast can actually reach.
function renderNotifRecipientSummary() {
  const summary = document.getElementById('notifReachSummary');
  if (!summary) return;
  const active = state.employees.filter(emp => emp.isActive);
  const reachable = active.filter(emp => emp.hasFcmToken);
  summary.textContent = `${reachable.length} of ${active.length} active employees have a registered device`;
}

// ─── Send tab ─────────────────────────────────────────────────────────

function collectSendPayload() {
  const target = getSegmentValue('notifTargetGroup', 'target') || 'all_users';
  const payload = {
    target,
    title: document.getElementById('notifTitle').value.trim(),
    body: document.getElementById('notifBody').value.trim(),
    imageUrl: document.getElementById('notifImageUrl').value.trim(),
    actionUrl: document.getElementById('notifActionUrl').value.trim()
  };
  if (target === 'selected_users') payload.recipientUids = sendPicker.uids();
  return payload;
}

function renderNotifJsonPreview() {
  const preview = document.getElementById('notifJsonPreview');
  if (!preview) return;
  preview.textContent = JSON.stringify(collectSendPayload(), null, 2);
  renderNotifRecipientSummary();
}

async function handleSendNotification(event) {
  event.preventDefault();
  const payload = collectSendPayload();

  if (payload.target === 'selected_users' && payload.recipientUids.length === 0) {
    alert('Please search and select at least one employee.');
    return;
  }

  const audience = payload.target === 'all_users'
    ? 'all active employees'
    : `${payload.recipientUids.length} selected employee(s)`;
  if (!confirm(`Send this notification to ${audience}?`)) return;

  setBtnLoading('btnSendNotification', true);

  try {
    const res = await fetch('/api/notifications/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    alert(data.message || (data.success ? 'Notification sent.' : 'Failed to send notification.'));

    if (data.success) {
      document.getElementById('notifSendForm').reset();
      sendPicker.clear();
      renderNotifJsonPreview();
      fetchNotificationHistory();
    }
  } catch (err) {
    console.error('Error sending notification:', err);
    alert('Could not connect to server.');
  } finally {
    setBtnLoading('btnSendNotification', false);
  }
}

// ─── History tab ──────────────────────────────────────────────────────

async function fetchNotificationHistory() {
  const tbody = document.getElementById('notifHistoryTable');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;">Loading...</td></tr>`;

  const params = new URLSearchParams({
    page: String(notifState.historyPage),
    limit: String(NOTIF_HISTORY_PAGE_SIZE)
  });
  const search = document.getElementById('notifHistorySearch').value.trim();
  const target = document.getElementById('notifHistoryTarget').value;
  const status = document.getElementById('notifHistoryStatus').value;
  const dateFrom = document.getElementById('notifHistoryFrom').value;
  const dateTo = document.getElementById('notifHistoryTo').value;

  if (search) params.set('search', search);
  if (target) params.set('target', target);
  if (status) params.set('status', status);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  try {
    const res = await fetch(`/api/notifications/history?${params.toString()}`);
    const data = await res.json();

    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger);">${escapeHtml(data.message || 'Failed to load history.')}</td></tr>`;
      return;
    }

    notifState.historyLogs = data.data.logs;
    notifState.historyTotalCount = data.data.totalCount;
    notifState.historyHasMore = data.data.hasMore;
    // Drop selections that are no longer on screen.
    notifState.historySelection = new Set(
      [...notifState.historySelection].filter(id => notifState.historyLogs.some(log => log.id === id))
    );
    renderNotificationHistory();
  } catch (err) {
    console.error('Error fetching notification history:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger);">Could not connect to server.</td></tr>`;
  }
}

function renderNotificationHistory() {
  const tbody = document.getElementById('notifHistoryTable');
  const logs = notifState.historyLogs;

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">No notifications found.</td></tr>`;
  } else {
    tbody.innerHTML = logs.map(log => {
      const checked = notifState.historySelection.has(log.id) ? 'checked' : '';
      const statusClass = log.status === 'success' ? 'success' : 'failed';
      const failureNote = log.error
        ? `<div class="user-sub" style="color:var(--danger);">${escapeHtml(log.error)}</div>`
        : '';
      return `
        <tr>
          <td><input type="checkbox" data-history-select="${escapeHtml(log.id)}" ${checked}></td>
          <td>
            <div>${escapeHtml(formatNotifTimestamp(log.timestamp))}</div>
            <div class="user-sub">${escapeHtml(formatNotifTimeAgo(log.timestamp))}</div>
          </td>
          <td><span class="badge target">${escapeHtml(notifTargetLabel(log.target))}</span></td>
          <td><div class="user-name">${escapeHtml(log.title)}</div></td>
          <td style="max-width:260px; font-size:13px; color:var(--text-muted);">${escapeHtml(notifBodyPreview(log.body))}</td>
          <td>${escapeHtml(notifDeliverySummary(log))}</td>
          <td>
            <span class="badge ${statusClass}">${escapeHtml(notifStatusLabel(log.status))}</span>
            ${failureNote}
          </td>
          <td>
            <button class="btn-secondary" style="padding:4px 12px; font-size:12px;" onclick="openNotifDetail('${escapeHtml(log.id)}')">View</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-history-select]').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const id = event.target.getAttribute('data-history-select');
        if (event.target.checked) notifState.historySelection.add(id);
        else notifState.historySelection.delete(id);
        renderNotifHistorySelectionBar();
      });
    });
  }

  renderNotifHistorySelectionBar();
  renderNotifHistoryPagination();
}

function renderNotifHistorySelectionBar() {
  const count = notifState.historySelection.size;
  document.getElementById('notifHistorySelectionBar').style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('notifHistorySelectedCount').textContent = `${count} selected`;
  const selectAll = document.getElementById('notifHistorySelectAll');
  selectAll.checked = count > 0 && count === notifState.historyLogs.length;
}

function renderNotifHistoryPagination() {
  const bar = document.getElementById('notifHistoryPagination');
  const total = notifState.historyTotalCount;

  if (total === 0) {
    bar.style.display = 'none';
    return;
  }

  const start = (notifState.historyPage - 1) * NOTIF_HISTORY_PAGE_SIZE + 1;
  const end = Math.min(start + notifState.historyLogs.length - 1, total);
  bar.style.display = 'flex';
  document.getElementById('notifHistoryRange').textContent = `Showing ${start}-${end} of ${total}`;
  document.getElementById('notifHistoryPrev').disabled = notifState.historyPage <= 1;
  document.getElementById('notifHistoryNext').disabled = !notifState.historyHasMore;
}

window.openNotifDetail = function(logId) {
  const log = notifState.historyLogs.find(item => item.id === logId);
  if (!log) return;

  notifState.detailLogId = logId;

  const row = (label, value) => `
    <div class="detail-item" style="margin-bottom:14px;">
      <span>${escapeHtml(label)}</span>
      <p style="white-space:pre-wrap;">${escapeHtml(value)}</p>
    </div>
  `;

  const recipients = Array.isArray(log.recipientNames) && log.recipientNames.length > 0
    ? log.recipientNames.join(', ')
    : notifTargetLabel(log.target);

  let html = '';
  html += row('Sent At', `${formatNotifTimestamp(log.timestamp)} (${formatNotifTimeAgo(log.timestamp)})`);
  html += row('Target', notifTargetLabel(log.target));
  html += row('Recipients', recipients);
  html += row('Title', log.title);
  html += row('Body', log.body);
  html += row('Delivery', `${notifDeliverySummary(log)} — ${notifStatusLabel(log.status)}`);
  if (log.imageUrl) html += row('Image URL', log.imageUrl);
  if (log.actionUrl) html += row('Action URL', log.actionUrl);
  if (log.scheduledNotificationId) html += row('Source', 'Scheduled notification');
  if (log.error) html += row('Error', log.error);

  document.getElementById('notifDetailBody').innerHTML = html;

  const modal = document.getElementById('notifDetailModal');
  modal.style.display = 'flex';
  modal.classList.add('active');
};

window.closeNotifDetailModal = function() {
  const modal = document.getElementById('notifDetailModal');
  modal.classList.remove('active');
  modal.style.display = 'none';
};

// Pre-fills the send form from a past notification, like Text Bee's
// "Duplicate" action. Recipients are not restored — an old UID may no longer
// belong to an active employee, so they must be picked again.
function duplicateNotificationToSend() {
  const log = notifState.historyLogs.find(item => item.id === notifState.detailLogId);
  if (!log) return;

  document.getElementById('notifTitle').value = log.title || '';
  document.getElementById('notifBody').value = log.body || '';
  document.getElementById('notifImageUrl').value = log.imageUrl || '';
  document.getElementById('notifActionUrl').value = log.actionUrl || '';

  const target = log.target === 'all_users' ? 'all_users' : 'selected_users';
  const group = document.getElementById('notifTargetGroup');
  group.querySelectorAll('.segment').forEach(segment => {
    segment.classList.toggle('active', segment.getAttribute('data-target') === target);
  });
  sendPicker.clear();
  sendPicker.setVisible(target === 'selected_users');

  closeNotifDetailModal();
  switchNotifSubTab('send');
  renderNotifJsonPreview();
}

async function deleteNotifications(ids, collection) {
  if (ids.length === 0) return;
  if (!confirm(`${ids.length} notification(s) will be permanently deleted. Are you sure?`)) return;

  try {
    const res = await fetch('/api/notifications/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, collection })
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || 'Failed to delete notifications.');
      return;
    }

    if (collection === 'notification_logs') {
      notifState.historySelection = new Set();
      fetchNotificationHistory();
    } else {
      notifState.scheduledSelection = new Set();
      fetchScheduledNotifications();
    }
  } catch (err) {
    console.error('Error deleting notifications:', err);
    alert('Could not connect to server.');
  }
}

// ─── Scheduled tab ────────────────────────────────────────────────────

async function fetchScheduledNotifications() {
  const tbody = document.getElementById('notifScheduledTable');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading...</td></tr>`;

  try {
    const res = await fetch('/api/notifications/scheduled');
    const data = await res.json();

    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--danger);">${escapeHtml(data.message || 'Failed to load scheduled notifications.')}</td></tr>`;
      return;
    }

    notifState.scheduled = data.data;
    notifState.scheduledSelection = new Set(
      [...notifState.scheduledSelection].filter(id => notifState.scheduled.some(item => item.id === id))
    );
    renderScheduledNotifications();
  } catch (err) {
    console.error('Error fetching scheduled notifications:', err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--danger);">Could not connect to server.</td></tr>`;
  }
}

function renderScheduledNotifications() {
  const tbody = document.getElementById('notifScheduledTable');
  const items = notifState.scheduled;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No scheduled notifications yet.</td></tr>`;
  } else {
    tbody.innerHTML = items.map(item => {
      const checked = notifState.scheduledSelection.has(item.id) ? 'checked' : '';
      const recipients = Array.isArray(item.recipientNames) && item.recipientNames.length > 0
        ? item.recipientNames.join(', ')
        : '';
      const cancelBtn = item.status === 'pending'
        ? `<button class="btn-secondary" style="padding:4px 10px; font-size:12px; color:var(--warning); margin-right:4px;" onclick="cancelScheduledNotification('${escapeHtml(item.id)}')">Cancel</button>`
        : '';
      return `
        <tr>
          <td><input type="checkbox" data-scheduled-select="${escapeHtml(item.id)}" ${checked}></td>
          <td>
            <div>${escapeHtml(formatNotifTimestamp(item.scheduledAt))}</div>
            <div class="user-sub">${escapeHtml(notifBodyPreview(item.body))}</div>
          </td>
          <td>
            <span class="badge target">${escapeHtml(notifTargetLabel(item.target))}</span>
            ${recipients ? `<div class="user-sub">${escapeHtml(recipients)}</div>` : ''}
          </td>
          <td><div class="user-name">${escapeHtml(item.title)}</div></td>
          <td>${escapeHtml(notifRecurringLabel(item))}</td>
          <td><span class="badge ${escapeHtml(item.status)}">${escapeHtml(notifStatusLabel(item.status))}</span></td>
          <td>
            ${cancelBtn}
            <button class="btn-secondary" style="padding:4px 10px; font-size:12px; color:var(--danger);" onclick="deleteScheduledNotification('${escapeHtml(item.id)}')">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-scheduled-select]').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const id = event.target.getAttribute('data-scheduled-select');
        if (event.target.checked) notifState.scheduledSelection.add(id);
        else notifState.scheduledSelection.delete(id);
        renderNotifScheduledSelectionBar();
      });
    });
  }

  renderNotifScheduledSelectionBar();
}

function renderNotifScheduledSelectionBar() {
  const count = notifState.scheduledSelection.size;
  document.getElementById('notifScheduledSelectionBar').style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('notifScheduledSelectedCount').textContent = `${count} selected`;
  const selectAll = document.getElementById('notifScheduledSelectAll');
  selectAll.checked = count > 0 && count === notifState.scheduled.length;
}

window.openScheduleNotifModal = function() {
  document.getElementById('scheduleNotifForm').reset();
  schedulePicker.clear();
  schedulePicker.setVisible(false);

  document.getElementById('scheduleTargetGroup').querySelectorAll('.segment').forEach(segment => {
    segment.classList.toggle('active', segment.getAttribute('data-target') === 'all_users');
  });
  document.getElementById('scheduleRecurringType').querySelectorAll('.segment').forEach(segment => {
    segment.classList.toggle('active', segment.getAttribute('data-recurring') === 'daily');
  });
  document.getElementById('scheduleRecurringTypeGroup').style.display = 'none';

  // Default to one hour from now, and never allow a past slot.
  document.getElementById('scheduleAt').value = getDhakaDateTimeLocal(60);
  document.getElementById('scheduleAt').min = getDhakaDateTimeLocal(1);

  const modal = document.getElementById('scheduleNotifModal');
  modal.style.display = 'flex';
  modal.classList.add('active');
};

window.closeScheduleNotifModal = function() {
  const modal = document.getElementById('scheduleNotifModal');
  modal.classList.remove('active');
  modal.style.display = 'none';
};

async function handleScheduleNotification(event) {
  event.preventDefault();

  const target = getSegmentValue('scheduleTargetGroup', 'target') || 'all_users';
  const isRecurring = document.getElementById('scheduleRecurring').checked;
  const scheduledAt = document.getElementById('scheduleAt').value;

  if (target === 'selected_users' && schedulePicker.uids().length === 0) {
    alert('Please search and select at least one employee.');
    return;
  }
  if (!scheduledAt) {
    alert('Scheduled time is required.');
    return;
  }

  const payload = {
    target,
    title: document.getElementById('scheduleTitle').value.trim(),
    body: document.getElementById('scheduleBody').value.trim(),
    // Interpreted as Dhaka wall-clock time by the API, like every other date
    // this dashboard submits.
    scheduledAt,
    imageUrl: document.getElementById('scheduleImageUrl').value.trim(),
    actionUrl: document.getElementById('scheduleActionUrl').value.trim(),
    isRecurring
  };
  if (target === 'selected_users') payload.recipientUids = schedulePicker.uids();
  if (isRecurring) payload.recurringType = getSegmentValue('scheduleRecurringType', 'recurring') || 'daily';

  setBtnLoading('btnSaveSchedule', true);

  try {
    const res = await fetch('/api/notifications/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      closeScheduleNotifModal();
      fetchScheduledNotifications();
    } else {
      alert(data.message || 'Failed to schedule notification.');
    }
  } catch (err) {
    console.error('Error scheduling notification:', err);
    alert('Could not connect to server.');
  } finally {
    setBtnLoading('btnSaveSchedule', false);
  }
}

window.cancelScheduledNotification = async function(notificationId) {
  if (!confirm('Cancel this scheduled notification?')) return;

  try {
    const res = await fetch('/api/notifications/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationId })
    });
    const data = await res.json();
    if (data.success) fetchScheduledNotifications();
    else alert(data.message || 'Failed to cancel notification.');
  } catch (err) {
    console.error('Error cancelling scheduled notification:', err);
    alert('Could not connect to server.');
  }
};

window.deleteScheduledNotification = function(notificationId) {
  deleteNotifications([notificationId], 'scheduled_notifications');
};

async function runDueScheduledNotifications() {
  setBtnLoading('btnRunScheduled', true);
  try {
    const res = await fetch('/api/notifications/run-scheduled', { method: 'POST' });
    const data = await res.json();
    alert(data.message || 'Done.');
    fetchScheduledNotifications();
    fetchNotificationHistory();
  } catch (err) {
    console.error('Error running scheduled notifications:', err);
    alert('Could not connect to server.');
  } finally {
    setBtnLoading('btnRunScheduled', false);
  }
}
