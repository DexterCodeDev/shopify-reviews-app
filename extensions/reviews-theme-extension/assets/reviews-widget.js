(() => {
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  const stars = (rating) => {
    const rounded = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return `<span class="rc-stars" aria-label="${rounded} out of 5 stars">${"★".repeat(rounded)}${"☆".repeat(5 - rounded)}</span>`;
  };

  const projectionUrl = (element) => {
    const base = String(element.dataset.cdnBase || "").replace(/\/$/, "");
    if (!base) return "";
    return `${base}/v1/shops/${encodeURIComponent(element.dataset.shopKey)}/products/${encodeURIComponent(element.dataset.productId)}.json`;
  };

  async function loadProjection(element) {
    const url = projectionUrl(element);
    if (!url) throw new Error("The reviews app block needs a Projection CDN base URL.");
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(response.status === 404 ? "No reviews are published yet." : "Reviews are temporarily unavailable.");
    return response.json();
  }

  function renderDistribution(distribution, total) {
    return [5, 4, 3, 2, 1].map((rating) => {
      const count = Number(distribution?.[rating] || 0);
      const width = total ? Math.round((count / total) * 100) : 0;
      return `<div class="rc-dist-row"><span>${rating}★</span><span class="rc-dist-track"><span style="width:${width}%"></span></span><span>${count}</span></div>`;
    }).join("");
  }

  function renderReview(review, shopKey) {
    const response = review.seller_response?.body
      ? `<div class="rc-response"><strong>Store response</strong><p>${escapeHtml(review.seller_response.body)}</p></div>`
      : "";
    return `<article class="rc-review" data-review-id="${escapeHtml(review.review_id)}">
      <div class="rc-review-head"><div>${stars(review.rating)}</div><time>${new Date(Number(review.created_at) * 1000).toLocaleDateString()}</time></div>
      <h3>${escapeHtml(review.title || "Review")}</h3>
      <p>${escapeHtml(review.body)}</p>
      <div class="rc-review-meta"><strong>${escapeHtml(review.author?.display_name || "Anonymous")}</strong>${review.is_verified_purchase ? '<span class="rc-verified">Verified purchase</span>' : ""}</div>
      <button type="button" class="rc-helpful" data-helpful data-shop-key="${escapeHtml(shopKey)}" data-review-id="${escapeHtml(review.review_id)}">Helpful (${Number(review.helpful_count || 0)})</button>
      ${response}
    </article>`;
  }

  function renderForm(element) {
    if (element.dataset.showForm !== "true") return "";
    return `<details class="rc-form-wrap"><summary>Write a review</summary>
      <form class="rc-form" data-review-form>
        <label>Rating<select name="rating" required><option value="">Select</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Average</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option></select></label>
        <label>Name<input name="author_name" maxlength="80" required></label>
        <label>Title<input name="title" maxlength="120"></label>
        <label>Review<textarea name="body" rows="5" maxlength="5000" required></textarea></label>
        <button type="submit">Submit review</button><p class="rc-form-status" data-form-status></p>
      </form></details>`;
  }

  async function renderWidget(element) {
    try {
      const projection = await loadProjection(element);
      const stats = projection.statistics || {};
      const reviews = Array.isArray(projection.reviews) ? projection.reviews : [];
      element.innerHTML = `<header class="rc-header"><div><p class="rc-eyebrow">${escapeHtml(element.dataset.heading || "Customer reviews")}</p><div class="rc-score">${stars(stats.average_rating)} <strong>${Number(stats.average_rating || 0).toFixed(1)}</strong> <span>(${Number(stats.total_review_count || 0)})</span></div></div></header>
        <div class="rc-layout"><div class="rc-distribution">${renderDistribution(stats.rating_distribution, Number(stats.total_review_count || 0))}</div><div class="rc-list">${reviews.length ? reviews.map((review) => renderReview(review, element.dataset.shopKey)).join("") : '<p class="rc-empty">Be the first to review this product.</p>'}</div></div>
        ${renderForm(element)}`;
      bindWidgetActions(element);
    } catch (error) {
      element.innerHTML = `<div class="rc-empty">${escapeHtml(error.message)}</div>${renderForm(element)}`;
      bindWidgetActions(element);
    }
  }

  function bindWidgetActions(element) {
    element.querySelectorAll("[data-helpful]").forEach((button) => {
      button.addEventListener("click", async () => {
        const base = String(element.dataset.apiBase || "").replace(/\/$/, "");
        if (!base) return;
        button.disabled = true;
        try {
          const key = "rc-voter-token";
          const token = localStorage.getItem(key) || crypto.randomUUID();
          localStorage.setItem(key, token);
          await fetch(`${base}/api/public/${encodeURIComponent(button.dataset.shopKey)}/reviews/${encodeURIComponent(button.dataset.reviewId)}/votes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vote_type: "helpful", voter_token: token })
          });
          button.textContent = "Thanks for your feedback";
        } catch {
          button.disabled = false;
        }
      });
    });

    const form = element.querySelector("[data-review-form]");
    if (form) form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = form.querySelector("[data-form-status]");
      const submit = form.querySelector("button[type=submit]");
      const base = String(element.dataset.apiBase || "").replace(/\/$/, "");
      if (!base) { status.textContent = "The app block needs a Public API base URL."; return; }
      submit.disabled = true;
      status.textContent = "Submitting…";
      const data = Object.fromEntries(new FormData(form));
      const idempotencyKey = crypto.randomUUID();
      try {
        const response = await fetch(`${base}/api/public/${encodeURIComponent(element.dataset.shopKey)}/products/${encodeURIComponent(element.dataset.productId)}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || "Review submission failed.");
        status.textContent = result.status.startsWith("Approved") ? "Thank you. Your review is now live." : "Thank you. Your review was submitted for moderation.";
        form.reset();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function renderSummary(element) {
    try {
      const projection = await loadProjection(element);
      const stats = projection.statistics || {};
      element.innerHTML = `${stars(stats.average_rating)} <strong>${Number(stats.average_rating || 0).toFixed(1)}</strong> <span>(${Number(stats.total_review_count || 0)})</span>`;
    } catch {
      element.textContent = "Not yet rated";
    }
  }

  document.querySelectorAll("[data-rc-widget]").forEach(renderWidget);
  document.querySelectorAll("[data-rc-rating-summary]").forEach(renderSummary);
})();
