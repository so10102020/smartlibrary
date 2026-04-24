// ===== 貸出管理（最適化版） =====
(function(){
  'use strict';
  
  let loansCache = [];
  
  window.initLoansDashboard = function() {
    refreshLoans();
  };
  
  window.refreshLoans = async function() {
    try {
      const status = window.$('loanStatusFilter')?.value || 'active';
      window.showActionResult('処理中', '貸出データ読み込み中...', 'processing');
      
      const db = window.adminState.db;
      const limitN = 50; // 🔥 100件→50件に削減
      
      let snaps = [];
      if (status === 'all') {
        const [a, r] = await Promise.all([
          db.collection('loans').where('status','==','active').limit(limitN).get(),
          db.collection('loans').where('status','==','returned').limit(limitN).get()
        ]);
        snaps = [...a.docs, ...r.docs];
      } else {
        const s = await db.collection('loans').where('status','==', status).limit(limitN).get();
        snaps = s.docs;
      }
      
      loansCache = snaps.map(d => ({ id: d.id, ...d.data() }));
      const resolved = await resolveJoins(loansCache);
      
      let rows = resolved.slice();
      rows.sort((a,b) => {
        const ao = a.overdue ? 1 : 0, bo = b.overdue ? 1 : 0;
        if (ao !== bo) return bo - ao;
        const at = (a.checked_out_at?.toDate ? a.checked_out_at.toDate().getTime() : 0);
        const bt = (b.checked_out_at?.toDate ? b.checked_out_at.toDate().getTime() : 0);
        return bt - at;
      });
      
      rows = filterSearch(rows);
      rows = applyOverdueFilter(rows);
      renderLoansTable(rows);
      
      window.showElement('actionResultSection', false);
    } catch (e) {
      console.error(e);
      window.showActionResult('エラー', '貸出データ読み込み失敗', 'error');
    }
  };
  
  async function resolveJoins(loans) {
    const db = window.adminState.db;
    const userIds = new Set();
    const bookIds = new Set();
    
    for (const l of loans) {
      const uid = l.uid || l.user_id;
      if (uid) userIds.add(uid);
      const bid = l.book_id || l.book_ref;
      if (bid) bookIds.add(bid);
    }
    
    const userMap = new Map();
    const bookMap = new Map();
    
    await Promise.all([
      Promise.all([...userIds].map(async uid => {
        try {
          const snap = await db.collection('users').doc(uid).get();
          if (snap.exists) userMap.set(uid, snap.data());
        } catch(e){}
      })),
      Promise.all([...bookIds].map(async bid => {
        try {
          const snap = await db.collection('books').doc(bid).get();
          if (snap.exists) bookMap.set(bid, { id: snap.id, ...snap.data() });
        } catch(e){}
      }))
    ]);
    
    return loans.map(l => {
      const uid = l.uid || l.user_id || '';
      const bid = l.book_id || l.book_ref || '';
      const u = userMap.get(uid) || {};
      const b = bookMap.get(bid) || {};
      const due = l.due_at || null;
      const status = l.status || 'active';
      const overdue = status === 'active' && due && 
        ((due?.toDate ? due.toDate() : new Date(due)) < new Date());
      
      return {
        id: l.id,
        status,
        overdue,
        user_id: u.user_id || uid,
        user_name: u.name || u.display_name || u.email || '',
        book_id: b.id || bid,
        title: l.book_title || b.title || '',
        isbn: b.isbn13 || b.isbn || '',
        checked_out_at: l.checked_out_at || l.created_at,
        due_at: due,
        returned_at: l.returned_at
      };
    });
  }
  
  function renderLoansTable(rows) {
    const container = window.$('loansTableContainer');
    const summaryEl = window.$('loansSummary');
    if (!container) return;
    
    const total = rows.length;
    const active = rows.filter(r => r.status === 'active').length;
    const overdue = rows.filter(r => r.overdue).length;
    
    if (summaryEl) {
      summaryEl.innerHTML = `総件数: ${total} / 貸出中: ${active} / 延滞: <span style="color:#c62828;">${overdue}</span>`;
    }
    
    if (!rows.length) {
      container.innerHTML = '<p>該当する貸出はありません</p>';
      return;
    }
    
    const header = `
      <table class="preview-table">
        <thead>
          <tr>
            <th>利用者</th>
            <th>書名</th>
            <th>貸出日</th>
            <th>返却期限</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    const body = rows.map(r => {
      const name = window.escapeHtml(`${r.user_name || '-'} (${r.user_id || '-'})`);
      const book = window.escapeHtml(r.title || '-');
      const dueTxt = window.fmtDate(r.due_at);
      const statusTxt = r.status === 'active' ? 
        (r.overdue ? '<span style="color:#c62828;">延滞</span>' : '貸出中') : '返却済み';
      
      return `
        <tr>
          <td>${name}</td>
          <td>${book}</td>
          <td>${window.fmtDate(r.checked_out_at)}</td>
          <td>${dueTxt}</td>
          <td>${statusTxt}</td>
        </tr>
      `;
    }).join('');
    
    container.innerHTML = header + body + '</tbody></table>';
  }
  
  function filterSearch(rows) {
    const term = (window.$('loanSearchTerm')?.value || '').trim().toLowerCase();
    if (!term) return rows;
    
    return rows.filter(r => {
      return (
        String(r.user_name || '').toLowerCase().includes(term) ||
        String(r.user_id || '').toLowerCase().includes(term) ||
        String(r.title || '').toLowerCase().includes(term) ||
        String(r.isbn || '').toLowerCase().includes(term)
      );
    });
  }
  
  function applyOverdueFilter(rows) {
    const only = window.$('loanOverdueOnly')?.checked;
    if (!only) return rows;
    return rows.filter(r => r.overdue);
  }
  
  window.exportLoansCsv = function() {
    const table = document.querySelector('#loansTableContainer table');
    if (!table) {
      window.showActionResult('エラー', 'エクスポート対象がありません', 'error');
      return;
    }
    
    const rows = [];
    const trs = table.querySelectorAll('tbody tr');
    trs.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      rows.push({
        user: tds[0]?.innerText || '',
        book: tds[1]?.innerText || '',
        checked_out: tds[2]?.innerText || '',
        due_at: tds[3]?.innerText || '',
        status: tds[4]?.innerText || ''
      });
    });
    
    const csv = window.Papa?.unparse ? Papa.unparse(rows) :
      rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loans_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  console.log('✅ admin-loans.js loaded');
})();
