(function () {
    "use strict";

    document.querySelectorAll("[data-account-copy]").forEach(function (button) {
        button.addEventListener("click", async function () {
            const email = button.dataset.email || "";
            if (!email) return;
            await window.NodeMailCopyFeedback.copy(button, email);
        });
    });

    document.querySelectorAll("[data-login-out]").forEach(function (button) {
        button.addEventListener("click", async function () {
            if (button.disabled) return;
            const menu = button.closest("[data-account-actions]");
            const status = menu ? menu.querySelector("[data-account-status]") : null;
            button.disabled = true;
            if (status) status.textContent = document.body.dataset.msgLogoutProcessing || "";
            try {
                const response = await fetch(button.dataset.url || "/api/auth/logout", {
                    method: "POST",
                    headers: { "content-type": "application/json" }
                });
                if (!response.ok) throw new Error("logout failed");
                window.localStorage.removeItem("user");
                window.location.replace(button.dataset.loginUrl || "/user/login.cgi");
            } catch (_error) {
                button.disabled = false;
                if (status) status.textContent = document.body.dataset.msgLogoutFailed || "退出失败，请重试。";
            }
        });
    });

    document.addEventListener("click", function (event) {
        document.querySelectorAll("[data-account-actions][open]").forEach(function (menu) {
            if (!menu.contains(event.target)) menu.removeAttribute("open");
        });
    });

    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        document.querySelectorAll("[data-account-actions][open]").forEach(function (menu) {
            menu.removeAttribute("open");
        });
    });
})();

