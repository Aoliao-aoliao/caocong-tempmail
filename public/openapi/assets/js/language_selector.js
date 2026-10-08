(function () {
    "use strict";

    const choices = [
        { value: "zh-CN", label: "\u7b80\u4f53\u4e2d\u6587", code: "ZH-CN", symbol: "\u7b80" },
        { value: "zh-TW", label: "\u7e41\u9ad4\u4e2d\u6587", code: "ZH-TW", symbol: "\u7e41" },
        { value: "en-US", label: "English", code: "EN-US", symbol: "EN" }
    ];

    function makeSelector() {
        const root = document.createElement("div");
        root.className = "language-switcher";
        root.dataset.languageSwitcher = "";

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "language-trigger";
        trigger.setAttribute("aria-haspopup", "listbox");
        trigger.setAttribute("aria-expanded", "false");
        const storedLanguage = window.localStorage.getItem("nodemail.language");
        const currentLanguage = storedLanguage || document.documentElement.lang || "en-US";
        const currentChoice = choices.find(function (choice) { return choice.value === currentLanguage; }) || choices[2];
        trigger.innerHTML = '<span class="language-current">' + currentChoice.label + '</span><i class="language-chevron" aria-hidden="true"></i>';

        const menu = document.createElement("div");
        menu.className = "language-menu";
        menu.setAttribute("role", "listbox");
        menu.setAttribute("aria-label", currentChoice.label);
        menu.hidden = true;

        choices.forEach(function (choice) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "language-option";
            option.dataset.language = choice.value;
            option.setAttribute("role", "option");
            option.setAttribute("aria-selected", String(choice.value === currentChoice.value));
            option.innerHTML = '<span class="language-symbol" aria-hidden="true">' + choice.symbol + '</span><span class="language-copy"><strong>' + choice.label + '</strong><small>' + choice.code + '</small></span><span class="language-check" aria-hidden="true">\u2713</span>';
            option.addEventListener("click", function () {
                if (option.disabled || choice.value === document.documentElement.lang) {
                    close(root);
                    return;
                }
                menu.querySelectorAll(".language-option").forEach(function (item) {
                    item.setAttribute("aria-selected", String(item === option));
                });
                trigger.querySelector(".language-current").textContent = choice.label;
                document.documentElement.lang = choice.value;
                window.localStorage.setItem("nodemail.language", choice.value);
                close(root);
                trigger.focus();
            });
            menu.append(option);
        });

        trigger.addEventListener("click", function () {
            const opening = menu.hidden;
            closeAll(root);
            menu.hidden = !opening;
            root.classList.toggle("open", opening);
            trigger.setAttribute("aria-expanded", String(opening));
            if (opening) {
                const selected = menu.querySelector('[aria-selected="true"]');
                if (selected) window.setTimeout(function () { selected.focus(); }, 0);
            }
        });
        menu.addEventListener("keydown", function (event) {
            const options = Array.from(menu.querySelectorAll(".language-option"));
            const current = options.indexOf(document.activeElement);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const direction = event.key === "ArrowDown" ? 1 : -1;
                options[(current + direction + options.length) % options.length].focus();
            }
        });
        root.append(trigger, menu);
        return root;
    }

    function close(root) {
        if (!root) return;
        const menu = root.querySelector(".language-menu");
        const trigger = root.querySelector(".language-trigger");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
        root.classList.remove("open");
    }

    function closeAll(except) {
        document.querySelectorAll("[data-language-switcher]").forEach(function (root) {
            if (root !== except) close(root);
        });
    }

    function place(selector) {
        const accountBar = document.querySelector(".top-account-bar");
        if (accountBar) {
            accountBar.prepend(selector);
            return;
        }
        const guestNav = document.querySelector(".guest-topbar nav");
        if (guestNav) {
            guestNav.prepend(selector);
            return;
        }
        const siteNav = document.querySelector(".site-header .site-nav");
        if (siteNav) {
            const accountEntry = siteNav.querySelector('a[href="/user/center.cgi"],a[href="/user/login.cgi"],a[href="/user/register.cgi"]');
            siteNav.insertBefore(selector, accountEntry || null);
            return;
        }
        const authBar = document.querySelector(".auth-topbar");
        if (authBar) {
            const group = document.createElement("div");
            group.className = "language-header-group";
            const action = authBar.querySelector(".topbar-action");
            authBar.append(group);
            group.append(selector);
            if (action) group.append(action);
            return;
        }
        const adminHead = document.querySelector(".admin-content-head");
        if (adminHead) {
            const group = document.createElement("div");
            group.className = "language-header-group";
            Array.from(adminHead.children).slice(1).forEach(function (node) { group.append(node); });
            group.prepend(selector);
            adminHead.append(group);
            return;
        }
        selector.classList.add("floating");
        document.body.append(selector);
    }

    place(makeSelector());
    document.addEventListener("click", function (event) {
        if (!event.target.closest("[data-language-switcher]")) closeAll();
    });
    document.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        const open = document.querySelector("[data-language-switcher].open");
        closeAll();
        if (open) open.querySelector(".language-trigger").focus();
    });
})();

