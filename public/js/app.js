// Sarah Time Dashboard - Client Frontend App Logic

let state = {
  currentTab: 'dashboard',
  selectedDate: getTodayDhakaDate(),
  stats: null,
  employees: [],
  attendanceLogs: [],
  officeSettings: null,
  dateOverrides: [],
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
  loadAllData();
});

function initUI() {
  // Set default date input value
  const dateInput = document.getElementById('selectedDate');
  dateInput.value = state.selectedDate;

  dateInput.addEventListener('change', (e) => {
    state.selectedDate = e.target.value;
    loadAllData();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadAllData();
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
  
  document.getElementById('editAttendanceForm').addEventListener('submit', handleAttendanceEditSubmit);
  
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
    settings: { title: 'Office & Policy Settings', sub: 'Configure geofencing and working hours' }
  };

  if (titleMap[tabName]) {
    document.getElementById('currentTabTitle').textContent = titleMap[tabName].title;
    document.getElementById('currentTabSub').textContent = titleMap[tabName].sub;
  }

  if (tabName === 'settings') {
    setTimeout(initOrUpdateMap, 200);
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

async function loadAllData() {
  showLoader();
  await Promise.all([
    fetchStats(),
    fetchEmployees(),
    fetchAttendanceLogs(),
    fetchSettings()
  ]);
  hideLoader();
}

async function fetchStats() {
  try {
    const res = await fetch(`/api/stats?date=${state.selectedDate}`);
    const data = await res.json();
    if (data.success) {
      state.stats = data.stats;
      renderStatsCards();
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

function renderStatsCards() {
  if (!state.stats) return;
  
  const banner = document.getElementById('holidayBanner');
  if (state.stats.isHoliday) {
    banner.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg> <span>Office Status: <strong>${state.stats.holidayReason || state.stats.holidayStatusText}</strong></span>`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
  
  document.getElementById('statTotalEmployees').textContent = state.stats.activeEmployees;
  document.getElementById('statPresent').textContent = state.stats.presentCount;
  document.getElementById('statLate').textContent = state.stats.lateCount;
  document.getElementById('statAbsent').textContent = state.stats.absentCount;
}

async function fetchEmployees() {
  try {
    const res = await fetch(`/api/employees?date=${state.selectedDate}`);
    const data = await res.json();
    if (data.success) {
      state.employees = data.employees;
      renderDashSummary();
      renderEmployeeDirectory();
    }
  } catch (err) {
    console.error('Error fetching employees:', err);
  }
}

async function fetchAttendanceLogs() {
  try {
    const res = await fetch(`/api/attendance?date=${state.selectedDate}`);
    const data = await res.json();
    if (data.success) {
      state.attendanceLogs = data.logs;
      renderAttendanceLogs();
    }
  } catch (err) {
    console.error('Error fetching attendance logs:', err);
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings/office');
    const data = await res.json();
    if (data.success) {
      state.officeSettings = data.settings;
      state.dateOverrides = data.dateOverrides;
      populateSettingsForm();
      renderDateOverrides();
      initOrUpdateMap();
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
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
              <div class="user-sub">${p.employeeId || emp.employeeCode}</div>
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
    const matchesSearch = log.employeeName.toLowerCase().includes(query) || log.employeeCode.toLowerCase().includes(query);
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
        <td>${log.employeeCode}</td>
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
    const code = (emp.profile.employeeId || emp.employeeCode).toLowerCase();
    return name.includes(query) || code.includes(query);
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
        <td>${p.employeeId || emp.employeeCode}</td>
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
      loadAllData();
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
        const idStr = (e.profile?.employeeId || e.employeeCode || '');
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
  document.getElementById('editEmpId').value = p.employeeId || emp.employeeCode || '';
  document.getElementById('editEmpDesignation').value = p.designation || '';
  document.getElementById('editEmpDepartment').value = p.department || '';
  document.getElementById('editEmpType').value = p.employmentType || '';
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
      await loadAllData();
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
      await loadAllData();
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
    weeklyOfficeDays: [1, 2, 3, 4, 5, 6, 7]
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
      fetchSettings();
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
      fetchSettings();
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
      fetchSettings();
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
    // timeStr could be like '10:15 AM'
    const parts = timeStr.match(/(\d+):(\d+)\s(AM|PM)/i);
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
  
  document.getElementById('editAttendanceModal').style.display = 'flex';
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
      document.getElementById('editAttendanceModal').style.display = 'none';
      loadAllData(); // refresh dashboard to reflect changes
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
