// ===== CSV一括登録（最適化版） =====
(function(){
  'use strict';
  
  let csvData = [];
  
  // CSV解析ヘルパー
  function normalizeKey(k) {
    return String(k || '').replace(/\uFEFF/g,'').trim().toLowerCase();
  }
  
  function cleanRow(row) {
    const out = {};
    for (const k in row) {
      const nk = normalizeKey(k);
      let v = row[k];
      if (typeof v === 'string') v = v.replace(/\uFEFF/g,'').trim();
      out[nk] = v;
    }
    return out;
  }
  
  function getFirst(row, candidates) {
    for (const key of candidates) {
      const nk = normalizeKey(key);
      if (row[nk] != null && String(row[nk]).trim() !== '') {
        return String(row[nk]).trim();
      }
    }
    return '';
  }
  
  // タグパース
  function parseTags(str) {
    if (!str) return [];
    return String(str).split(/[、，,;\s]+/).map(s => s.trim()).filter(Boolean);
  }
  
  // 🔥 最小限のデータマッピング（Firestoreコスト削減）
  function mapCsvRow(row) {
    const isbnRaw = getFirst(row, ['isbn13','isbn','ＩＳＢＮ']);
    const isbn13 = window.extractIsbn13(isbnRaw);
    
    // 必須フィールドのみ
    const title = getFirst(row, ['title','タイトル','タイトル (巻・版)','書名','name','書誌名']);
    
    // タイトルがない場合はスキップ（ISBNだけでは登録しない）
    if (!title || title.trim() === '') {
      console.warn('タイトルなし、スキップ:', row);
      return null;
    }
    
    // 🔥 頁数（在庫数と混同しない）
    const pagesStr = getFirst(row, ['pages','頁数','ページ']);
    const pages = pagesStr ? parseInt(String(pagesStr).replace(/[^0-9]/g,'')) || null : null;
    
    // 🔥 在庫数（デフォルト1、上限999）
    const stockStr = getFirst(row, ['stock_count','在庫数','在庫','冊数','stock']);
    let stock = 1;
    if (stockStr && String(stockStr).trim() !== '') {
      const parsed = parseInt(String(stockStr).replace(/[^0-9]/g,''));
      if (parsed >= 1 && parsed <= 999) stock = parsed;
    }
    
    return {
      isbn13,
      title: title,
      authors: getFirst(row, ['authors','author','著者']) || '',
      publisher: getFirst(row, ['publisher','出版社']) || '',
      published: getFirst(row, ['published','出版年']) || '',
      pages,
      price: parseInt(getFirst(row, ['price','定価']) || '0') || null,
      stock_count: stock,
      category: getFirst(row, ['category','分類','ジャンル']) || '',
      // 館内管理フィールド（オプション）
      call_number: getFirst(row, ['請求記号','call_number']) || '',
      accession_number: getFirst(row, ['登録番号','accession_number']) || '',
      shelf_location: getFirst(row, ['配架場所','shelf_location']) || '',
      status: getFirst(row, ['状態','status']) || '在架',
      notes: getFirst(row, ['備考','notes']) || ''
    };
  }
  
  // CSV/Excelプレビュー
  window.previewCsvFile = function() {
    const fileInput = window.$('csvFileInput');
    const file = fileInput?.files?.[0];
    if (!file) return;
    
    const filename = (file.name || '').toLowerCase();
    
    if (filename.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        delimitersToGuess: [',', '\t', '|', ';'],
        complete: (res) => {
          csvData = (res.data || []).map(cleanRow);
          displayCsvPreview(csvData);
          window.showElement('csvPreview', true);
        },
        error: (err) => {
          window.showActionResult('エラー', `CSV解析エラー: ${err.message}`, 'error');
        }
      });
      return;
    }
    
    // Excel
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const workbook = XLSX.read(e.target.result, { type: 'binary' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        csvData = data.map(cleanRow);
        displayCsvPreview(csvData);
        window.showElement('csvPreview', true);
      } catch (error) {
        window.showActionResult('エラー', `ファイル読み込みエラー`, 'error');
      }
    };
    reader.readAsBinaryString(file);
  };
  
  function displayCsvPreview(data) {
    if (data.length === 0) return;
    
    const headers = Object.keys(data[0]);
    let html = '<table class="preview-table"><thead><tr>';
    headers.forEach(h => html += `<th>${window.escapeHtml(h)}</th>`);
    html += '</tr></thead><tbody>';
    
    data.slice(0, 5).forEach(row => {
      html += '<tr>';
      headers.forEach(h => html += `<td>${window.escapeHtml(row[h] || '')}</td>`);
      html += '</tr>';
    });
    
    html += `</tbody></table><p>プレビュー: ${Math.min(5, data.length)}/${data.length}行</p>`;
    window.$('csvPreviewTable').innerHTML = html;
  }
  
  // 🔥 軽量登録（最小限のフィールド）
  async function registerBookMinimal(bookData) {
    const db = window.adminState.db;
    const user = window.adminState.auth.currentUser;
    
    if (!user || !window.adminState.isAuthenticated) {
      throw new Error('管理者権限が必要です');
    }
    
    // ISBN重複チェック（ある場合）
    if (bookData.isbn13) {
      const existing = await db.collection('books')
        .where('isbn13', '==', bookData.isbn13)
        .limit(1)
        .get();
      
      if (!existing.empty) {
        // 在庫数を増やす
        const doc = existing.docs[0];
        const current = doc.data();
        await doc.ref.update({
          stock_count: (current.stock_count || 0) + bookData.stock_count,
          available_count: (current.available_count || 0) + bookData.stock_count,
          updated_at: firebase.firestore.FieldValue.serverTimestamp()
        });
        return { id: doc.id, updated: true };
      }
    }
    
    // 新規登録（最小限）
    const docRef = db.collection('books').doc();
    const now = firebase.firestore.FieldValue.serverTimestamp();
    
    const bookDoc = {
      book_id: docRef.id,
      isbn13: bookData.isbn13 || null,
      isbn: bookData.isbn13 || null,
      title: bookData.title,
      authors: bookData.authors,
      publisher: bookData.publisher,
      published: bookData.published,
      pages: bookData.pages,
      price: bookData.price,
      stock_count: bookData.stock_count,
      available_count: bookData.stock_count,
      category: bookData.category,
      call_number: bookData.call_number,
      accession_number: bookData.accession_number,
      shelf_location: bookData.shelf_location,
      status: bookData.status,
      notes: bookData.notes,
      // 検索用（シンプル）
      isbn_digits: window.onlyDigits(bookData.isbn13 || ''),
      search_blob: window.normalizeForSearch(
        [bookData.title, bookData.authors, bookData.isbn13].filter(Boolean).join(' ')
      ),
      created_at: now,
      updated_at: now,
      created_by: user.uid
    };
    
    await docRef.set(bookDoc);
    return { id: docRef.id, data: bookDoc };
  }
  
  // CSV一括インポート
  window.importCsvData = async function() {
    if (csvData.length === 0) {
      window.showActionResult('エラー', 'データがありません', 'error');
      return;
    }
    
    window.showElement('importProgress', true);
    let imported = 0;
    let errors = 0;
    let skipped = 0;
    
    for (let i = 0; i < csvData.length; i++) {
      try {
        const mapped = mapCsvRow(csvData[i]);
        
        if (!mapped) {
          skipped++;
          continue;
        }
        
        await registerBookMinimal(mapped);
        imported++;
        
      } catch (e) {
        console.error(`行${i+1}エラー:`, e.message);
        errors++;
      }
      
      const progress = ((i + 1) / csvData.length) * 100;
      window.$('importProgressFill').style.width = `${progress}%`;
      window.$('importProgressText').textContent = `${i + 1}/${csvData.length} 処理完了`;
      
      // 🔥 100件ごとに待機（API制限対策）
      if ((i + 1) % 100 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    window.showElement('importProgress', false);
    window.showActionResult(
      'インポート完了', 
      `成功: ${imported}件 / エラー: ${errors}件 / スキップ: ${skipped}件`, 
      imported > 0 ? 'success' : 'warning'
    );
    
    clearCsvImport();
  };
  
  function clearCsvImport() {
    window.$('csvFileInput').value = '';
    csvData = [];
    window.showElement('csvPreview', false);
    window.$('csvPreviewTable').innerHTML = '';
  }
  
  window.clearCsvImport = clearCsvImport;
  
  console.log('✅ admin-csv.js loaded');
})();
