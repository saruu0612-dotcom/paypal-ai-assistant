(function () {
  function showAlert(el, message) {
    if (!el) return;
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function setButtonLoading(btn, loading, loadingLabel, idleLabel) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.dataset.idleHtml = btn.dataset.idleHtml || btn.innerHTML;
      btn.innerHTML = `<span class="spinner"></span><span>${escapeHtml(loadingLabel)}</span>`;
    } else if (idleLabel) {
      btn.textContent = idleLabel;
    } else if (btn.dataset.idleHtml) {
      btn.innerHTML = btn.dataset.idleHtml;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Home page: Create Escrow Job + AI Checklist Builder ---
  const builderRoot = document.getElementById('job-builder');
  if (builderRoot) {
    const descInput = document.getElementById('job-description');
    const priceInput = document.getElementById('job-price');
    const generateForm = document.getElementById('checklist-form');
    const generateBtn = document.getElementById('generate-checklist-btn');
    const regenerateBtn = document.getElementById('regenerate-checklist-btn');
    const createError = document.getElementById('create-error');
    const createErrorText = document.getElementById('create-error-text');
    const createRetryBtn = document.getElementById('create-retry-btn');
    const checklistStep = document.getElementById('checklist-step');

    function showCreateError(message, allowRetry = false) {
      if (!createError || !createErrorText) return;
      if (!message) {
        createError.classList.add('hidden');
        createErrorText.textContent = '';
        if (createRetryBtn) createRetryBtn.classList.add('hidden');
        return;
      }
      createErrorText.textContent = message;
      if (createRetryBtn) createRetryBtn.classList.toggle('hidden', !allowRetry);
      createError.classList.remove('hidden');
    }
    const titleInput = document.getElementById('job-title-input');
    const editorList = document.getElementById('checklist-editor-list');
    const addItemBtn = document.getElementById('add-item-btn');
    const createJobBtn = document.getElementById('create-job-btn');

    let checklistItems = [];

    function renderChecklistEditor() {
      editorList.innerHTML = '';
      checklistItems.forEach((value, idx) => {
        const row = document.createElement('div');
        row.className = 'checklist-editor-row';

        const num = document.createElement('span');
        num.className = 'item-num';
        num.textContent = String(idx + 1);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input';
        input.value = value;
        input.maxLength = 300;
        input.placeholder = 'Specific, verifiable deliverable requirement';
        input.addEventListener('input', (e) => {
          checklistItems[idx] = e.target.value;
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-ghost-danger';
        removeBtn.textContent = 'Remove';
        removeBtn.disabled = checklistItems.length <= 1;
        removeBtn.title = checklistItems.length <= 1 ? 'At least 1 checklist item is required' : 'Remove item';
        removeBtn.addEventListener('click', () => {
          if (checklistItems.length <= 1) return;
          checklistItems.splice(idx, 1);
          renderChecklistEditor();
        });

        row.appendChild(num);
        row.appendChild(input);
        row.appendChild(removeBtn);
        editorList.appendChild(row);
      });

      if (addItemBtn) {
        addItemBtn.disabled = checklistItems.length >= 6;
      }
    }

    document.querySelectorAll('[data-sample-desc]').forEach((chip) => {
      chip.addEventListener('click', () => {
        descInput.value = chip.getAttribute('data-sample-desc') || '';
        const samplePrice = chip.getAttribute('data-sample-price');
        if (samplePrice) priceInput.value = samplePrice;
        showCreateError('');
      });
    });

    async function requestChecklist(triggerBtn) {
      showCreateError('');
      const description = descInput.value.trim();
      const price = priceInput.value.trim();

      if (description.length < 10) {
        showCreateError('Please describe the work in at least a sentence (10+ characters) so Gemini can create a clear checklist.');
        descInput.focus();
        return;
      }
      if (!price || Number(price) <= 0) {
        showCreateError('Please enter a valid job price in USD (greater than $0.00).');
        priceInput.focus();
        return;
      }

      setButtonLoading(triggerBtn, true, 'Generating Checklist...');
      if (regenerateBtn && triggerBtn !== regenerateBtn) regenerateBtn.disabled = true;
      if (createRetryBtn && triggerBtn !== createRetryBtn) createRetryBtn.disabled = true;

      try {
        const res = await fetch('/api/jobs/checklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, price }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Could not generate checklist from Gemini AI.');
        }

        titleInput.value = data.title || '';
        checklistItems = Array.isArray(data.items) ? data.items.slice() : [];
        renderChecklistEditor();
        checklistStep.classList.remove('hidden');
        checklistStep.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        showCreateError(err.message || 'Failed to generate AI checklist.', true);
      } finally {
        setButtonLoading(triggerBtn, false);
        if (regenerateBtn) regenerateBtn.disabled = false;
        if (createRetryBtn) createRetryBtn.disabled = false;
      }
    }

    if (createRetryBtn) {
      createRetryBtn.addEventListener('click', () => {
        requestChecklist(createRetryBtn);
      });
    }

    if (generateForm) {
      generateForm.addEventListener('submit', (e) => {
        e.preventDefault();
        requestChecklist(generateBtn);
      });
    }

    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', () => {
        requestChecklist(regenerateBtn);
      });
    }

    if (addItemBtn) {
      addItemBtn.addEventListener('click', () => {
        if (checklistItems.length >= 6) return;
        checklistItems.push('');
        renderChecklistEditor();
        const inputs = editorList.querySelectorAll('input');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      });
    }

    if (createJobBtn) {
      createJobBtn.addEventListener('click', async () => {
        showCreateError('');
        const description = descInput.value.trim();
        const price = priceInput.value.trim();
        const title = titleInput.value.trim();
        const cleanedItems = checklistItems.map((item) => item.trim()).filter(Boolean);

        if (cleanedItems.length === 0) {
          showCreateError('Please keep at least one non-empty checklist item before creating the job.');
          return;
        }

        setButtonLoading(createJobBtn, true, 'Creating Job...');
        try {
          const res = await fetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              description,
              price,
              items: cleanedItems,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || 'Could not create the job.');
          }
          window.location.href = `/job/${encodeURIComponent(data.job.id)}?role=client`;
        } catch (err) {
          showCreateError(err.message || 'Failed to create job.');
          setButtonLoading(createJobBtn, false);
        }
      });
    }
  }

  // --- Job detail page (/job/:id) ---
  const jobPageRoot = document.getElementById('job-page');
  if (jobPageRoot) {
    const jobId = jobPageRoot.getAttribute('data-job-id');
    let activeRole = jobPageRoot.getAttribute('data-initial-role') === 'freelancer' ? 'freelancer' : 'client';

    const roleButtons = document.querySelectorAll('[data-role-btn]');
    const rolePanels = document.querySelectorAll('[data-role-panel]');

    function applyRole(role, updateUrl) {
      activeRole = role === 'freelancer' ? 'freelancer' : 'client';
      roleButtons.forEach((btn) => {
        const isMatch = btn.getAttribute('data-role-btn') === activeRole;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
      });
      rolePanels.forEach((panel) => {
        const isMatch = panel.getAttribute('data-role-panel') === activeRole;
        panel.classList.toggle('hidden', !isMatch);
      });
      if (updateUrl) {
        const url = new URL(window.location.href);
        url.searchParams.set('role', activeRole);
        url.searchParams.delete('notice');
        window.history.replaceState({}, '', url.toString());
      }
    }

    roleButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        applyRole(btn.getAttribute('data-role-btn'), true);
      });
    });

    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const shareUrl =
          jobPageRoot.getAttribute('data-share-url') ||
          `${window.location.origin}/job/${encodeURIComponent(jobId)}`;
        try {
          await navigator.clipboard.writeText(shareUrl);
          const original = copyBtn.textContent;
          copyBtn.textContent = 'Link Copied!';
          setTimeout(() => {
            copyBtn.textContent = original;
          }, 1800);
        } catch {
          window.prompt('Copy this shareable job URL:', shareUrl);
        }
      });
    }

    const acceptBtn = document.getElementById('accept-job-btn');
    const actionError = document.getElementById('job-action-error');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', async () => {
        showAlert(actionError, '');
        setButtonLoading(acceptBtn, true, 'Accepting Job...');
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || 'Could not accept job.');
          }
          window.location.href = `/job/${encodeURIComponent(jobId)}?role=freelancer&notice=accepted`;
        } catch (err) {
          showAlert(actionError, err.message || 'Could not accept job.');
          setButtonLoading(acceptBtn, false);
        }
      });
    }

    const fundForm = document.getElementById('fund-job-form');
    const fundBtn = document.getElementById('fund-job-btn');
    if (fundForm && fundBtn) {
      fundForm.addEventListener('submit', (e) => {
        if (fundBtn.disabled) {
          e.preventDefault();
          return;
        }
        setButtonLoading(fundBtn, true, 'Redirecting to PayPal...');
      });
    }

    // Submission mode toggle + submission handler
    const submitForm = document.getElementById('submit-work-form');
    if (submitForm) {
      let submissionType = 'text';
      const tabButtons = document.querySelectorAll('[data-submit-mode]');
      const textGroup = document.getElementById('submit-text-group');
      const urlGroup = document.getElementById('submit-url-group');
      const textInput = document.getElementById('submission-text');
      const urlInput = document.getElementById('submission-url');
      const submitBtn = document.getElementById('submit-work-btn');
      const liveReviewBox = document.getElementById('ai-review-live-box');
      const statusBadge = document.getElementById('job-status-badge');

      tabButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          submissionType = btn.getAttribute('data-submit-mode') === 'url' ? 'url' : 'text';
          tabButtons.forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
          textGroup.classList.toggle('hidden', submissionType !== 'text');
          urlGroup.classList.toggle('hidden', submissionType !== 'url');
          showAlert(actionError, '');
        });
      });

      submitForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showAlert(actionError, '');

        const payload =
          submissionType === 'url'
            ? { submissionType: 'url', url: urlInput.value.trim() }
            : { submissionType: 'text', text: textInput.value.trim() };

        if (submissionType === 'url' && !payload.url) {
          showAlert(actionError, 'Please enter the public URL of your completed deliverable.');
          urlInput.focus();
          return;
        }
        if (submissionType === 'text' && !payload.text) {
          showAlert(actionError, 'Please paste your completed text or code before submitting.');
          textInput.focus();
          return;
        }

        setButtonLoading(submitBtn, true, 'Under AI Review...');
        if (liveReviewBox) liveReviewBox.classList.remove('hidden');
        if (statusBadge) {
          statusBadge.className = 'status-badge status-review';
          statusBadge.innerHTML = '<span class="status-dot"></span><span>Under AI review</span>';
        }

        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (data.job && data.job.status === 'Under AI review') {
              window.location.href = `/job/${encodeURIComponent(jobId)}?role=${encodeURIComponent(activeRole)}`;
              return;
            }
            throw new Error(data.error || 'Submission failed.');
          }
          window.location.href = `/job/${encodeURIComponent(jobId)}?role=${encodeURIComponent(activeRole)}&notice=completed`;
        } catch (err) {
          if (liveReviewBox) liveReviewBox.classList.add('hidden');
          if (statusBadge) {
            statusBadge.className = 'status-badge status-funded';
            statusBadge.innerHTML = '<span class="status-dot"></span><span>Funded</span>';
          }
          showAlert(actionError, err.message || 'Could not submit work for AI review.');
          setButtonLoading(submitBtn, false);
        }
      });
    }

    document.querySelectorAll('[data-retry-settlement-btn]').forEach((retryBtn) => {
      retryBtn.addEventListener('click', async () => {
        showAlert(actionError, '');
        setButtonLoading(retryBtn, true, 'Trying again...');
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry-settlement`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || 'Retry failed. Please try again.');
          }
          window.location.href = `/job/${encodeURIComponent(jobId)}?role=${encodeURIComponent(activeRole)}&notice=completed`;
        } catch (err) {
          showAlert(actionError, err.message || 'Retry failed.');
          setButtonLoading(retryBtn, false);
        }
      });
    });
  }
})();

