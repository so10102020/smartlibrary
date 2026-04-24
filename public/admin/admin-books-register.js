// ===== 図書登録（手動・一括・スキャン結果登録） =====
(function(){
  'use strict';

  let currentScannedBook = null;
  let batchResults = [];

  const $ = (id) => window.$ ? window.$(id) : document.getElementById(id);

  function parseTags(str) {
    if (!str) return [];
    return String(str)
      .split(/[、，,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function toNullableInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  function toPositiveInt(value, fallback = 1) {
    const n = parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  async function fetchBookMetadata(isbn13) {
    try {
      const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}`);
      if (response.ok) {
        const data = await response.json();
        const item = (data.items && data.items[0]) ? data.items[0].volumeInfo : null;
        if (item) {
          return {
            isbn13,
            title: item.title || '',
            authors: (item.authors || []).join(', '),
            publisher: item.publisher || '',
            published: item.publishedDate || '',
            pages: item.pageCount || null,
            series: item.series || '',
            price: item.listPrice?.amount || null,
            description: item.description || '',
            categories: (item.categories || []).join(', '),
            thumbnail: item.imageLinks?.thumbnail || ''
          };
        }
      }
    } catch (error) {
      console.warn('Google Books API error:', error);
    }

    try {
      const response2 = await fetch(`https://openlibrary.org/isbn/${isbn13}.json`);
      if (response2.ok) {
        const data2 = await response2.json();
        return {
          isbn13,
          title: data2.title || '',
          authors: Array.isArray(data2.authors) ? data2.authors.map(a => a.name || a.key).join(', ') : '',
          publisher: Array.isArray(data2.publishers) ? data2.publishers.join(', ') : '',
          published: data2.publish_date || '',
          pages: data2.number_of_pages || null,
          series: '',
          price: null,
          description: '',
          categories: '',
          thumbnail: ''
        };
      }
    } catch (error) {
      console.warn('Open Library API error:', error);
    }

    return {
      isbn13,
      title: '',
      authors: '',
      publisher: '',
      published: '',
      pages: null,
      series: '',
      price: null,
      description: '',
      categories: '',
      thumbnail: ''
    };
  }

  function buildBookDoc(bookData, docId, userId) {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const isbn13 = bookData.isbn13 || null;
    const stockCount = toPositiveInt(bookData.stock_count, 1);

    const searchBlob = window.normalizeForSearch([
      bookData.title,
      bookData.authors,
      bookData.publisher,
      bookData.series,
      bookData.categories || bookData.category,
      bookData.call_number,
      bookData.accession_number,
      isbn13 || ''
    ].filter(Boolean).join(' '));

    return {
      book_id: docId,
      isbn13,
      isbn: isbn13,
      title: bookData.title,
      authors: bookData.authors || '',
      publisher: bookData.publisher || '',
      published: bookData.published || '',
      pages: bookData.pages || null,
      series: bookData.series || '',
      price: bookData.price || null,
      size: bookData.size || '',
      description: bookData.description || '',
      categories: bookData.categories || '',
      category: bookData.category || '',
      thumbnail: bookData.thumbnail || '',
      stock_count: stockCount,
      available_count: stockCount,
      notes: bookData.notes || '',
      status: bookData.status || '在架',
      copy_type: bookData.copy_type || '',
      accession_number: bookData.accession_number || '',
      call_number: bookData.call_number || '',
      material_type: bookData.material_type || '図書',
      acquisition_type: bookData.acquisition_type || '',
      acquisition_price: bookData.acquisition_price || null,
      acquisition_date: bookData.acquisition_date || '',
      current_location: bookData.current_location || '',
      shelf_location: bookData.shelf_location || '',
      temp_location: bookData.temp_location || '',
      loan_policy: bookData.loan_policy || '',
      loan_total: toNullableInt(bookData.loan_total) || 0,
      tags: Array.isArray(bookData.tags) ? bookData.tags : parseTags(bookData.tags),
      isbn_digits: window.onlyDigits(isbn13 || ''),
      search_blob: searchBlob,
      created_at: now,
      updated_at: now,
      created_by: userId
    };
  }

  async function registerBook(bookData) {
    const db = window.adminState.db;
    const user = window.adminState.auth?.currentUser;

    if (!user || !window.adminState.isAuthenticated) {
      throw new Error('管理者権限が必要です');
    }

    const isbn13 = window.extractIsbn13(bookData.isbn13 || bookData.isbn || '');
    const normalized = {
      ...bookData,
      isbn13: isbn13 || null,
      title: String(bookData.title || '').trim(),
      authors: String(bookData.authors || '').trim(),
      publisher: String(bookData.publisher || '').trim(),
      published: String(bookData.published || '').trim(),
      series: String(bookData.series || '').trim(),
      size: String(bookData.size || '').trim(),
      notes: String(bookData.notes || '').trim(),
      category: String(bookData.category || '').trim(),
      categories: String(bookData.categories || bookData.category || '').trim(),
      status: String(bookData.status || '在架').trim(),
      copy_type: String(bookData.copy_type || '').trim(),
      accession_number: String(bookData.accession_number || '').trim(),
      call_number: String(bookData.call_number || '').trim(),
      material_type: String(bookData.material_type || '図書').trim(),
      acquisition_type: String(bookData.acquisition_type || '').trim(),
      acquisition_date: String(bookData.acquisition_date || '').trim(),
      current_location: String(bookData.current_location || '').trim(),
      shelf_location: String(bookData.shelf_location || '').trim(),
      temp_location: String(bookData.temp_location || '').trim(),
      loan_policy: String(bookData.loan_policy || '').trim(),
      pages: toNullableInt(bookData.pages),
      price: toNullableInt(bookData.price),
      acquisition_price: toNullableInt(bookData.acquisition_price),
      stock_count: toPositiveInt(bookData.stock_count, 1),
      loan_total: toNullableInt(bookData.loan_total) || 0,
      tags: Array.isArray(bookData.tags) ? bookData.tags : parseTags(bookData.tags)
    };

    if (!normalized.title) {
      throw new Error('タイトルは必須です');
    }

    if (normalized.isbn13) {
      const existing = await db.collection('books')
        .where('isbn13', '==', normalized.isbn13)
        .limit(1)
        .get();

      if (!existing.empty) {
        const doc = existing.docs[0];
        const current = doc.data();
        const addCount = normalized.stock_count;

        await doc.ref.update({
          stock_count: (current.stock_count || 0) + addCount,
          available_count: (current.available_count || 0) + addCount,
          updated_at: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { id: doc.id, updated: true };
      }
    }

    const docRef = db.collection('books').doc();
    const bookDoc = buildBookDoc(normalized, docRef.id, user.uid);
    await docRef.set(bookDoc);
    return { id: docRef.id, data: bookDoc };
  }

  function displayBookInfo(bookData, containerId) {
    const container = $(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="book-card">
        ${bookData.thumbnail ? `<img src="${bookData.thumbnail}" alt="書籍画像" class="book-thumbnail">` : ''}
        <div class="book-details">
          <h4>${window.escapeHtml(bookData.title || '不明')}</h4>
          <p><strong>ISBN:</strong> ${bookData.isbn13 || '不明'}</p>
          <p><strong>著者:</strong> ${window.escapeHtml(bookData.authors || '不明')}</p>
          <p><strong>出版社:</strong> ${window.escapeHtml(bookData.publisher || '不明')}</p>
          <p><strong>出版年:</strong> ${bookData.published || '不明'}</p>
          ${bookData.pages ? `<p><strong>頁数:</strong> ${bookData.pages}ページ</p>` : ''}
          ${bookData.price ? `<p><strong>定価:</strong> ${bookData.price}円</p>` : ''}
          <div class="stock-control">
            <label>在庫数: </label>
            <input type="number" value="${bookData.stock_count || 1}" min="1" onchange="updateBookStock(this.value)">
          </div>
        </div>
      </div>
    `;
  }

  window.updateBookStock = function(value) {
    if (currentScannedBook) {
      currentScannedBook.stock_count = toPositiveInt(value, 1);
    }
  };

  window.handleBookScanResult = async function(isbn) {
    const isbn13 = window.extractIsbn13(isbn);
    if (!isbn13) {
      window.showActionResult('エラー', 'ISBNが認識できませんでした', 'error');
      return;
    }

    window.setText('scanProgress', '書籍情報を取得中...');
    try {
      const bookData = await fetchBookMetadata(isbn13);
      currentScannedBook = { ...bookData, stock_count: 1 };
      displayBookInfo(currentScannedBook, 'bookInfoCard');
      window.showElement('scanResultSection', true);
      window.setText('scanProgress', '書籍情報を取得しました');
    } catch (error) {
      console.error('Book scan error:', error);
      window.showActionResult('エラー', '書籍情報の取得に失敗しました', 'error');
    }
  };

  window.startBookScanner = function() {
    window.location.href = 'admin-barcode-scanner.html?mode=quick';
  };

  window.stopBookScanner = function() {
    window.setText('scanProgress', '専用スキャナー画面で読み取りを行ってください');
  };

  window.registerScannedBook = async function() {
    if (!currentScannedBook) {
      window.showActionResult('エラー', '登録する書籍が選択されていません', 'error');
      return;
    }

    try {
      window.showActionResult('処理中', '図書を登録しています...', 'processing');
      const result = await registerBook(currentScannedBook);
      const message = result.updated
        ? `「${window.escapeHtml(currentScannedBook.title)}」の在庫数を追加しました`
        : `「${window.escapeHtml(currentScannedBook.title)}」を登録しました`;
      window.showActionResult('登録完了', message, 'success');
      window.clearScanResult();
    } catch (error) {
      window.showActionResult('登録失敗', error.message, 'error');
    }
  };

  window.clearScanResult = function() {
    currentScannedBook = null;
    window.showElement('scanResultSection', false);
    window.setHtml('bookInfoCard', '');
    window.setText('scanProgress', '');
  };

  window.fetchBookDataByIsbn = async function() {
    const isbn = $('manualIsbn')?.value?.trim() || '';
    const isbn13 = window.extractIsbn13(isbn);

    if (!isbn13) {
      window.showActionResult('エラー', '有効なISBNを入力してください', 'error');
      return;
    }

    try {
      window.showActionResult('処理中', '書籍情報を取得中...', 'processing');
      const bookData = await fetchBookMetadata(isbn13);

      if ($('manualTitle')) $('manualTitle').value = bookData.title || '';
      if ($('manualAuthors')) $('manualAuthors').value = bookData.authors || '';
      if ($('manualPublisher')) $('manualPublisher').value = bookData.publisher || '';
      if ($('manualPublished')) $('manualPublished').value = bookData.published || '';
      if ($('manualSeries')) $('manualSeries').value = bookData.series || '';
      if ($('manualPages')) $('manualPages').value = bookData.pages || '';
      if ($('manualPrice')) $('manualPrice').value = bookData.price || '';
      if ($('manualCategory')) $('manualCategory').value = bookData.categories || '';

      window.showActionResult('取得完了', '書籍情報を取得しました', 'success');
    } catch (error) {
      window.showActionResult('取得失敗', '書籍情報の取得に失敗しました', 'error');
    }
  };

  window.submitManualBook = async function() {
    try {
      const formData = {
        isbn13: window.extractIsbn13($('manualIsbn')?.value || ''),
        title: $('manualTitle')?.value?.trim() || '',
        authors: $('manualAuthors')?.value?.trim() || '',
        publisher: $('manualPublisher')?.value?.trim() || '',
        published: $('manualPublished')?.value?.trim() || '',
        series: $('manualSeries')?.value?.trim() || '',
        pages: $('manualPages')?.value || null,
        size: $('manualSize')?.value?.trim() || '',
        price: $('manualPrice')?.value || null,
        stock_count: $('manualStock')?.value || 1,
        category: $('manualCategory')?.value?.trim() || '',
        notes: $('manualNotes')?.value?.trim() || '',
        status: $('manualStatus')?.value || '在架',
        copy_type: $('manualCopyType')?.value || '',
        accession_number: $('manualAccessionNumber')?.value?.trim() || '',
        call_number: $('manualCallNumber')?.value?.trim() || '',
        material_type: $('manualMaterialType')?.value?.trim() || '図書',
        acquisition_type: $('manualAcquisitionType')?.value?.trim() || '',
        acquisition_price: $('manualAcquisitionPrice')?.value || null,
        acquisition_date: $('manualAcquisitionDate')?.value || '',
        current_location: $('manualCurrentLocation')?.value?.trim() || '',
        shelf_location: $('manualShelfLocation')?.value?.trim() || '',
        temp_location: $('manualTempLocation')?.value?.trim() || '',
        loan_policy: $('manualLoanPolicy')?.value?.trim() || '',
        loan_total: $('manualLoanTotal')?.value || 0,
        tags: parseTags($('manualTags')?.value)
      };

      if (!formData.title) {
        window.showActionResult('エラー', 'タイトルは必須です', 'error');
        return;
      }

      window.showActionResult('処理中', '図書を登録しています...', 'processing');
      const result = await registerBook(formData);
      const message = result.updated
        ? `「${window.escapeHtml(formData.title)}」の在庫数を追加しました`
        : `「${window.escapeHtml(formData.title)}」を登録しました`;
      window.showActionResult('登録完了', message, 'success');
      window.clearManualForm();
    } catch (error) {
      window.showActionResult('登録失敗', error.message, 'error');
    }
  };

  window.clearManualForm = function() {
    const form = $('manualBookForm');
    if (form) form.reset();
  };

  window.processBatchIsbn = async function() {
    const raw = $('isbnBatchList')?.value || '';
    const isbnList = raw.split('\n').map(line => line.trim()).filter(Boolean);

    if (isbnList.length === 0) {
      window.showActionResult('エラー', 'ISBNリストを入力してください', 'error');
      return;
    }

    window.showElement('batchProgress', true);
    batchResults = [];

    for (let i = 0; i < isbnList.length; i++) {
      const isbn13 = window.extractIsbn13(isbnList[i]);
      if (!isbn13) {
        batchResults.push({ success: false, isbn: isbnList[i], error: '無効なISBN' });
      } else {
        try {
          const bookData = await fetchBookMetadata(isbn13);
          batchResults.push({ success: true, data: { ...bookData, stock_count: 1 } });
        } catch (error) {
          batchResults.push({ success: false, isbn: isbn13, error: error.message });
        }
      }

      const progress = ((i + 1) / isbnList.length) * 100;
      const progressFill = $('progressFill');
      const progressText = $('progressText');
      if (progressFill) progressFill.style.width = `${progress}%`;
      if (progressText) progressText.textContent = `${i + 1}/${isbnList.length} 処理完了`;
    }

    window.showElement('batchProgress', false);
    displayBatchResults(batchResults);
  };

  function displayBatchResults(results) {
    const container = $('batchResults');
    if (!container) return;

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let html = '<h3>取得結果</h3>';
    html += `<p>成功: ${successful.length}件、失敗: ${failed.length}件</p>`;

    if (successful.length > 0) {
      html += '<div class="batch-books">';
      successful.forEach((result, index) => {
        const book = result.data;
        html += `
          <div class="batch-book-item">
            <div class="book-info">
              <h4>${window.escapeHtml(book.title || '(タイトルなし)')}</h4>
              <p>ISBN: ${book.isbn13 || '-'} | 著者: ${window.escapeHtml(book.authors || '-')}</p>
            </div>
            <input type="number" value="1" min="1" onchange="updateBatchStock(${index}, this.value)">
          </div>
        `;
      });
      html += '</div>';
      html += '<button onclick="registerBatchBooks()" class="btn btn-success">全て登録</button>';
    }

    if (failed.length > 0) {
      html += '<h4>取得失敗</h4><ul>';
      failed.forEach(result => {
        html += `<li>ISBN: ${window.escapeHtml(result.isbn || '-')} - ${window.escapeHtml(result.error || '不明なエラー')}</li>`;
      });
      html += '</ul>';
    }

    container.innerHTML = html;
  }

  window.updateBatchStock = function(index, value) {
    const successful = batchResults.filter(r => r.success);
    if (successful[index]) {
      successful[index].data.stock_count = toPositiveInt(value, 1);
    }
  };

  window.registerBatchBooks = async function() {
    const successful = batchResults.filter(r => r.success);
    if (successful.length === 0) {
      window.showActionResult('エラー', '登録対象がありません', 'error');
      return;
    }

    let registered = 0;
    let failed = 0;

    window.showActionResult('処理中', '一括登録を実行中...', 'processing');

    for (const result of successful) {
      try {
        await registerBook(result.data);
        registered++;
      } catch (error) {
        console.error('Batch registration error:', error);
        failed++;
      }
    }

    window.showActionResult(
      '一括登録完了',
      `成功: ${registered}件 / 失敗: ${failed}件`,
      failed > 0 ? 'warning' : 'success'
    );

    window.clearBatchList();
  };

  window.clearBatchList = function() {
    if ($('isbnBatchList')) $('isbnBatchList').value = '';
    if ($('batchResults')) $('batchResults').innerHTML = '';
    batchResults = [];
  };

  window.registerBook = registerBook;

  document.addEventListener('DOMContentLoaded', () => {
    const manualForm = $('manualBookForm');
    if (manualForm) {
      manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        window.submitManualBook();
      });
    }
  });

  console.log('✅ admin-books-register.js loaded');
})();
