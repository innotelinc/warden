import UIKit
import WebKit

/**
 The browser surface: WARDEN's own chrome around a WebKit page engine.

 A browser that hides its address bar is not a browser, and a browser with one
 page is not one either — so this screen owns a small set of tabs, each a
 `WKWebView` in the session's data store, with WARDEN's address field, back,
 forward, reload/stop, find, reader, share, downloads and a per-site shield.

 What lives here rather than in the engine is the part an operator touches: the
 chrome, the tab strip's model, the sheets and the teardown. The policies it
 applies come from `WardenEngine` and `WardenPolicy`.
 */
final class WardenBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
    UITextFieldDelegate, WKDownloadDelegate {

    /**
     Two kinds of session on one surface.

     A `.privateMode` surface is the browser: its data store is non-persistent, so
     closing it ends the session exactly as the product claims. A `.service`
     surface — a chat or mail web app — keeps the default store, because a
     messaging app that asked for a login on every open would not be usable.
     iOS gives each store its own cookie jar, so the private teardown cannot reach
     a service's login.
     */
    enum Session {
        case privateMode
        case service
    }

    var onEvent: ((String, [String: Any]) -> Void)?
    var onDismiss: (() -> Void)?
    /// Scry's result, handed back as the JSON text the page produced — or nil
    /// when there was no page to read, which the bridge reports as an empty
    /// report rather than as a capture that failed.
    var onCapture: ((String?) -> Void)?

    /// Six is where a phone stops being a phone: past this the tab sheet is
    /// longer than the page it covers.
    private static let maxTabs = 6

    private let startURL: URL
    private let session: Session
    private let captureScript: String?
    private var captured = false

    /// One page engine and the little state the tab strip needs to draw it.
    private final class Tab {
        let webView: WKWebView
        var address: URL
        var title: String = ""

        init(webView: WKWebView, address: URL) {
            self.webView = webView
            self.address = address
        }
    }

    private var tabs: [Tab] = []
    private var active = 0
    private var progressObservation: NSKeyValueObservation?

    private let addressField = UITextField()
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private let reloadButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let shieldButton = UIButton(type: .system)
    private let tabsButton = UIButton(type: .system)
    private let shareButton = UIButton(type: .system)
    private let readerButton = UIButton(type: .system)
    private let findButton = UIButton(type: .system)
    private let hostLabel = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let pageHost = UIView()

    /// The engine for the tab in front. Every tab keeps its own web view, so the
    /// one that is not on screen keeps its scroll position and its history.
    private var webView: WKWebView {
        tabs[min(active, max(0, tabs.count - 1))].webView
    }

    init(startURL: URL, session: Session = .privateMode, captureScript: String? = nil) {
        self.startURL = startURL
        self.session = session
        self.captureScript = captureScript
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.027, green: 0.035, blue: 0.047, alpha: 1)

        configureChrome()

        let configuration = makeConfiguration()
        let host = WardenPolicy.host(startURL)
        WardenEngine.installScripts(
            on: configuration.userContentController,
            cookiesAllowed: WardenPolicy.shared.allowsCookies(host)
        )

        // The rules are compiled, not fetched, so this is the one moment they
        // can be attached. The first page waits for them: loading first and
        // attaching afterwards leaves the page the operator opened unfiltered.
        WardenAdBlocker.install(on: configuration.userContentController) { [weak self] in
            guard let strongSelf = self else { return }
            strongSelf.addFirstTab(url: strongSelf.startURL, configuration: configuration)
            strongSelf.load(strongSelf.startURL)
        }
    }

    private func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = session == .service ? .default() : .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        // Downloads go through this view controller, which saves them to the
        // app's Documents directory and hands the file to the share sheet.
        configuration.preferences.isFraudulentWebsiteWarningEnabled = true
        return configuration
    }

    // MARK: - Tabs

    private func addFirstTab(url: URL, configuration: WKWebViewConfiguration) {
        let tab = Tab(webView: makeWebView(configuration: configuration), address: url)
        tabs = [tab]
        active = 0
        attach(tab)
    }

    /**
     A new tab, with this host's policy already applied.

     The configuration is built per tab rather than copied, because both parts of
     the policy — the rule list and the scripts — are host-dependent: a site with
     blocking off must not inherit a neighbour's filters.
     */
    private func openTab(_ url: URL, select: Bool = true) {
        guard tabs.count < WardenBrowserViewController.maxTabs else {
            presentNotice("Six pages is the limit", "Close one to open another.")
            return
        }

        let host = WardenPolicy.host(url)
        let blocking = WardenPolicy.shared.isBlocking(host)
        let configuration = makeConfiguration()

        WardenEngine.installScripts(
            on: configuration.userContentController,
            cookiesAllowed: WardenPolicy.shared.allowsCookies(host)
        )

        let build: () -> Void = { [weak self] in
            guard let self = self else { return }
            let tab = Tab(webView: self.makeWebView(configuration: configuration), address: url)
            self.tabs.append(tab)
            if select {
                self.select(self.tabs.count - 1)
            }
            tab.webView.load(URLRequest(url: url))
        }

        if blocking {
            WardenEngine.rules { list in
                if let list = list {
                    configuration.userContentController.add(list)
                }
                build()
            }
        } else {
            build()
        }
    }

    private func makeWebView(configuration: WKWebViewConfiguration) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true
        view.allowsLinkPreview = true
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }

    private func attach(_ tab: Tab) {
        pageHost.subviews.forEach { $0.removeFromSuperview() }
        pageHost.addSubview(tab.webView)
        NSLayoutConstraint.activate([
            tab.webView.topAnchor.constraint(equalTo: pageHost.topAnchor),
            tab.webView.leadingAnchor.constraint(equalTo: pageHost.leadingAnchor),
            tab.webView.trailingAnchor.constraint(equalTo: pageHost.trailingAnchor),
            tab.webView.bottomAnchor.constraint(equalTo: pageHost.bottomAnchor)
        ])
        observeProgress(tab.webView)
        syncChrome()
    }

    private func select(_ index: Int) {
        guard index >= 0, index < tabs.count else { return }
        active = index
        attach(tabs[index])
    }

    private func closeTab(at index: Int) {
        guard index >= 0, index < tabs.count else { return }
        let tab = tabs.remove(at: index)
        tab.webView.stopLoading()
        tab.webView.navigationDelegate = nil
        tab.webView.uiDelegate = nil
        tab.webView.removeFromSuperview()

        if tabs.isEmpty {
            close()
            return
        }
        select(min(index, tabs.count - 1))
    }

    private func observeProgress(_ view: WKWebView) {
        progressObservation = view.observe(\.estimatedProgress, options: [.new]) { [weak self] observed, _ in
            let value = Float(observed.estimatedProgress)
            self?.progress.setProgress(value, animated: true)
            self?.progress.isHidden = value >= 1
        }
    }

    // MARK: - Chrome

    private func configureChrome() {
        let topRow = UIStackView()
        topRow.axis = .horizontal
        topRow.alignment = .center
        topRow.spacing = 5
        topRow.translatesAutoresizingMaskIntoConstraints = false

        doneButton.setTitle("Done", for: .normal)
        doneButton.setTitleColor(UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1), for: .normal)
        doneButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        addressField.delegate = self
        addressField.borderStyle = .roundedRect
        addressField.keyboardType = .URL
        addressField.autocapitalizationType = .none
        addressField.autocorrectionType = .no
        addressField.spellCheckingType = .no
        addressField.returnKeyType = .go
        addressField.clearButtonMode = .whileEditing
        addressField.textColor = .white
        addressField.tintColor = UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1)
        addressField.backgroundColor = UIColor(white: 1, alpha: 0.08)
        addressField.attributedPlaceholder = NSAttributedString(
            string: "Search or enter address",
            attributes: [.foregroundColor: UIColor(white: 0.62, alpha: 1)]
        )
        addressField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        addressField.heightAnchor.constraint(equalToConstant: 34).isActive = true

        style(reloadButton, system: "arrow.clockwise", accessibility: "Reload")
        reloadButton.addTarget(self, action: #selector(reload), for: .touchUpInside)

        topRow.addArrangedSubview(doneButton)
        topRow.addArrangedSubview(addressField)
        topRow.addArrangedSubview(reloadButton)

        let toolsRow = UIStackView()
        toolsRow.axis = .horizontal
        toolsRow.alignment = .center
        toolsRow.spacing = 4
        toolsRow.translatesAutoresizingMaskIntoConstraints = false

        style(backButton, system: "chevron.left", accessibility: "Back")
        style(forwardButton, system: "chevron.right", accessibility: "Forward")
        style(shieldButton, system: "shield", accessibility: "Site shield")
        style(tabsButton, system: "square.on.square", accessibility: "Tabs")
        style(shareButton, system: "square.and.arrow.up", accessibility: "Share")
        style(readerButton, system: "text.alignleft", accessibility: "Reader")
        style(findButton, system: "magnifyingglass", accessibility: "Find in page")

        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)
        shieldButton.addTarget(self, action: #selector(showShield), for: .touchUpInside)
        tabsButton.addTarget(self, action: #selector(showTabs), for: .touchUpInside)
        shareButton.addTarget(self, action: #selector(share), for: .touchUpInside)
        readerButton.addTarget(self, action: #selector(openReader), for: .touchUpInside)
        findButton.addTarget(self, action: #selector(showFind), for: .touchUpInside)

        hostLabel.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
        hostLabel.textColor = UIColor(white: 0.62, alpha: 1)
        hostLabel.translatesAutoresizingMaskIntoConstraints = false

        progress.trackTintColor = .clear
        progress.progressTintColor = UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1)
        progress.translatesAutoresizingMaskIntoConstraints = false

        pageHost.translatesAutoresizingMaskIntoConstraints = false

        toolsRow.addArrangedSubview(backButton)
        toolsRow.addArrangedSubview(forwardButton)
        toolsRow.addArrangedSubview(hostLabel)
        toolsRow.addArrangedSubview(shieldButton)
        toolsRow.addArrangedSubview(tabsButton)
        toolsRow.addArrangedSubview(findButton)
        toolsRow.addArrangedSubview(readerButton)
        toolsRow.addArrangedSubview(shareButton)

        view.addSubview(topRow)
        view.addSubview(toolsRow)
        view.addSubview(progress)
        view.addSubview(pageHost)

        NSLayoutConstraint.activate([
            topRow.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            topRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            topRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),

            toolsRow.topAnchor.constraint(equalTo: topRow.bottomAnchor, constant: 6),
            toolsRow.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            toolsRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),

            progress.topAnchor.constraint(equalTo: toolsRow.bottomAnchor, constant: 6),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progress.heightAnchor.constraint(equalToConstant: 2),

            pageHost.topAnchor.constraint(equalTo: progress.bottomAnchor),
            pageHost.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pageHost.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pageHost.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }

    private func style(_ button: UIButton, system name: String, accessibility: String) {
        button.setImage(UIImage(systemName: name), for: .normal)
        button.tintColor = UIColor(white: 0.85, alpha: 1)
        button.accessibilityLabel = accessibility
        button.widthAnchor.constraint(equalToConstant: 30).isActive = true
    }

    private func syncChrome() {
        guard !tabs.isEmpty else { return }
        let tab = tabs[active]
        let url = tab.webView.url ?? tab.address
        if !addressField.isFirstResponder {
            addressField.text = url.absoluteString
        }
        hostLabel.text = url.host ?? ""
        backButton.isEnabled = tab.webView.canGoBack
        forwardButton.isEnabled = tab.webView.canGoForward
        backButton.alpha = tab.webView.canGoBack ? 1 : 0.35
        forwardButton.alpha = tab.webView.canGoForward ? 1 : 0.35
        tabsButton.setTitle("\(active + 1)/\(tabs.count)", for: .normal)
        tabsButton.setTitleColor(UIColor(white: 0.85, alpha: 1), for: .normal)
        tabsButton.titleLabel?.font = .monospacedSystemFont(ofSize: 10, weight: .medium)

        // The shield states the policy, not a number: `WKWebView` does not report
        // how many requests a rule list refused, and inventing a count would be
        // the one lie a privacy screen cannot afford.
        let host = (url.host ?? "").lowercased()
        let blocking = WardenPolicy.shared.isBlocking(host)
        let cookies = WardenPolicy.shared.allowsCookies(host)
        shieldButton.tintColor = blocking
            ? UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1)
            : UIColor(red: 0.96, green: 0.73, blue: 0.36, alpha: 1)
        shieldButton.accessibilityLabel = blocking
            ? "Shield: filtering this site" + (cookies ? ", cookies allowed" : "")
            : "Shield: not filtering this site" + (cookies ? ", cookies allowed" : "")

        onEvent?("navigated", ["url": url.absoluteString, "title": tab.webView.title ?? ""])
    }

    // MARK: - Navigation

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    @objc private func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func goForward() {
        if webView.canGoForward { webView.goForward() }
    }

    @objc private func reload() {
        if webView.isLoading { webView.stopLoading() } else { webView.reload() }
    }

    @objc func close() {
        teardown()
        dismiss(animated: true) { [weak self] in self?.onDismiss?() }
    }

    /**
     The browser's teardown.

     The private store is in memory, so nothing is written to disk to delete — but
     the store lives as long as the process, not the screen, so a closed surface
     has to clear it or the next page would inherit the last one's cookies. A
     service surface is the deliberate exception and keeps its store.
     */
    private func teardown() {
        guard session == .privateMode else { return }
        for tab in tabs {
            tab.webView.stopLoading()
            tab.webView.configuration.userContentController.removeAllUserScripts()
        }
        WKWebsiteDataStore.nonPersistent().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast,
            completionHandler: {}
        )
    }

    private func showFailure(_ message: String, url: URL?) {
        progress.isHidden = true
        let text = url?.absoluteString ?? ""
        webView.loadHTMLString(WardenScripts.errorPage(url: text, message: message), baseURL: nil)
    }

    // MARK: - Site shield

    @objc private func showShield() {
        guard !tabs.isEmpty else { return }
        let url = tabs[active].webView.url ?? tabs[active].address
        let host = (url.host ?? "").lowercased()
        guard !host.isEmpty else { return }

        let blocking = WardenPolicy.shared.isBlocking(host)
        let cookies = WardenPolicy.shared.allowsCookies(host)

        let sheet = UIAlertController(
            title: host,
            message: blocking
                ? "WARDEN's lists are filtering this site. Cookies are \(cookies ? "allowed for this site (memory only)" : "refused, including from JavaScript")."
                : "Filtering is off for this site. Cookies are \(cookies ? "allowed for this site (memory only)" : "refused, including from JavaScript").",
            preferredStyle: .actionSheet
        )

        sheet.addAction(UIAlertAction(
            title: blocking ? "Turn filtering off for this site" : "Turn filtering on for this site",
            style: blocking ? .destructive : .default
        ) { [weak self] _ in
            WardenPolicy.shared.setBlocking(host, !blocking)
            self?.reloadAfterPolicyChange()
        })

        sheet.addAction(UIAlertAction(
            title: cookies ? "Refuse cookies for this site" : "Allow cookies for this site",
            style: .default
        ) { [weak self] _ in
            WardenPolicy.shared.setCookies(host, !cookies)
            if cookies {
                WardenEngine.purgeCookies(store: self?.store() ?? WKWebsiteDataStore.nonPersistent(), keeping: WardenPolicy.shared.allowedCookieHosts())
            }
            self?.reloadAfterPolicyChange()
        })

        sheet.addAction(UIAlertAction(title: "Clear cookies now", style: .destructive) { [weak self] _ in
            guard let self = self else { return }
            WardenEngine.purgeCookies(store: self.store(), keeping: []) { [weak self] in
                self?.presentNotice("Cookies cleared", "Nothing was written to disk to begin with.")
            }
        })

        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: nil))
        presentSheet(sheet)
    }

    private func store() -> WKWebsiteDataStore {
        session == .service ? .default() : .nonPersistent()
    }

    /**
     A policy change is a reload in a new engine.

     The rule list and the cookie lock are attached to a web view's configuration,
     which WebKit keeps for that view's lifetime, so the only honest way to apply
     a new policy is a new web view on the same address.
     */
    private func reloadAfterPolicyChange() {
        guard !tabs.isEmpty else { return }
        let current = tabs[active].webView.url ?? tabs[active].address
        let index = active
        let host = WardenPolicy.host(current)
        let blocking = WardenPolicy.shared.isBlocking(host)

        let configuration = makeConfiguration()
        WardenEngine.installScripts(
            on: configuration.userContentController,
            cookiesAllowed: WardenPolicy.shared.allowsCookies(host)
        )

        let replace: () -> Void = { [weak self] in
            guard let self = self else { return }
            let tab = Tab(webView: self.makeWebView(configuration: configuration), address: current)
            self.tabs[index].webView.removeFromSuperview()
            self.tabs[index] = tab
            self.attach(tab)
            tab.webView.load(URLRequest(url: current))
        }

        if blocking {
            WardenEngine.rules { list in
                if let list = list { configuration.userContentController.add(list) }
                replace()
            }
        } else {
            replace()
        }
    }

    // MARK: - Tabs sheet

    @objc private func showTabs() {
        let sheet = UIAlertController(title: "Tabs", message: nil, preferredStyle: .actionSheet)
        for (index, tab) in tabs.enumerated() {
            let label = tab.webView.title?.isEmpty == false ? tab.webView.title! : (tab.webView.url?.host ?? "New tab")
            sheet.addAction(UIAlertAction(
                title: (index == active ? "● " : "   ") + label,
                style: .default
            ) { [weak self] _ in
                self?.select(index)
            })
        }
        if tabs.count < WardenBrowserViewController.maxTabs {
            sheet.addAction(UIAlertAction(title: "New tab", style: .default) { [weak self] _ in
                self?.openTab(URL(string: "https://duckduckgo.com")!)
            })
        }
        if tabs.count > 1 {
            sheet.addAction(UIAlertAction(title: "Close this tab", style: .destructive) { [weak self] _ in
                guard let self = self else { return }
                self.closeTab(at: self.active)
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: nil))
        presentSheet(sheet)
    }

    // MARK: - Find, reader, share

    @objc private func showFind() {
        let alert = UIAlertController(title: "Find in page", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "Text on this page"
            field.autocapitalizationType = .none
        }
        alert.addAction(UIAlertAction(title: "Find", style: .default) { [weak self, weak alert] _ in
            guard let self = self, let term = alert?.textFields?.first?.text, !term.isEmpty else { return }
            self.find(term, backwards: false)
        })
        alert.addAction(UIAlertAction(title: "Previous", style: .default) { [weak self, weak alert] _ in
            guard let self = self, let term = alert?.textFields?.first?.text, !term.isEmpty else { return }
            self.find(term, backwards: true)
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: nil))
        present(alert, animated: true)
    }

    private func find(_ term: String, backwards: Bool) {
        let configuration = WKFindConfiguration()
        configuration.backwards = backwards
        configuration.wraps = true
        configuration.caseSensitive = false
        webView.find(term, configuration: configuration) { [weak self] result in
            if !result.matchFound {
                self?.presentNotice("Not on this page", "No match for “\(term)”.")
            }
        }
    }

    @objc private func openReader() {
        webView.evaluateJavaScript(WardenScripts.reader) { [weak self] result, error in
            guard let self = self else { return }
            guard let text = result as? String,
                  let data = text.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.presentNotice("Reader", error?.localizedDescription ?? "This page could not be read.")
                return
            }
            if let message = parsed["error"] as? String {
                self.presentNotice("Reader", message)
                return
            }
            let title = (parsed["title"] as? String) ?? "Reader"
            let html = (parsed["html"] as? String) ?? ""
            let url = (parsed["url"] as? String) ?? ""
            self.webView.loadHTMLString(WardenScripts.readerDocument(title: title, html: html, url: url), baseURL: nil)
        }
    }

    @objc private func share() {
        let url = tabs[active].webView.url ?? tabs[active].address
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = shareButton
            popover.sourceRect = shareButton.bounds
        }
        present(activity, animated: true)
    }

    // MARK: - Downloads

    /// Where each live download was told to write.
    ///
    /// `WKDownload` hands the destination to WebKit and never reports it back:
    /// there is no `fileURL` on a download, so the only record of where the file
    /// landed is the answer this delegate gave. Keyed by the download because
    /// several can be in flight at once, and removed when it finishes so the
    /// dictionary does not grow for the life of the surface.
    private var downloadTargets: [ObjectIdentifier: URL] = [:]

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            completionHandler(nil)
            return
        }
        var target = directory.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: target.path) {
            target = directory.appendingPathComponent("\(Int(Date().timeIntervalSince1970))-\(name)")
        }
        downloadTargets[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        DispatchQueue.main.async { [weak self] in
            let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let popover = activity.popoverPresentationController, let self = self {
                popover.sourceView = self.shareButton
                popover.sourceRect = self.shareButton.bounds
            }
            self?.present(activity, animated: true)
        }
    }

    // MARK: - Presentation helpers

    private func presentSheet(_ sheet: UIAlertController) {
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = shieldButton
            popover.sourceRect = shieldButton.bounds
        }
        present(sheet, animated: true)
    }

    private func presentNotice(_ title: String, _ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        progress.isHidden = false
        syncChrome()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.isHidden = true
        syncChrome()

        let host = (webView.url?.host ?? "").lowercased()
        if !WardenPolicy.shared.allowsCookies(host) {
            WardenEngine.purgeCookies(store: store(), keeping: WardenPolicy.shared.allowedCookieHosts())
        }

        guard let script = captureScript, !captured else { return }
        captured = true
        // A capture taken the instant the document settles misses the requests
        // a deferred script or a lazy image starts, and those are most of the
        // third parties the report exists to name.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            self?.runCapture(script)
        }
    }

    // MARK: - Scry

    /**
     Read the page as the page sees itself.

     The script is the shell's (`mobile/src/operator/capture.ts`), so the report
     is the same one the desktop builds from a debugger capture — this side only
     has to evaluate it and hand the text back.
     */
    func capture(_ script: String, completion: @escaping (String?) -> Void) {
        webView.evaluateJavaScript(script) { result, error in
            if let text = result as? String {
                completion(text)
            } else {
                completion(WardenBrowserViewController.failure(error?.localizedDescription ?? "The page could not be read"))
            }
        }
    }

    private func runCapture(_ script: String) {
        capture(script) { [weak self] text in
            guard let self = self else { return }
            self.onCapture?(text)
            // A surface opened to capture one page has done its job; the report
            // is behind it and the operator should see it without a second tap.
            self.close()
        }
    }

    private static func failure(_ message: String) -> String {
        let payload = ["error": message]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // A cancelled load is the operator leaving, not a failure to report.
        if (error as NSError).code == NSURLErrorCancelled { return }
        showFailure(error.localizedDescription, url: webView.url)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        showFailure(error.localizedDescription, url: webView.url)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""

        // http, https and about: stay in this view; anything else — a mailto:, a
        // phone number, an app deep link — belongs to the system, which is what
        // a browser does with a scheme it does not handle.
        if scheme.isEmpty || ["http", "https", "about", "data", "blob"].contains(scheme) {
            // HTTPS-only for the page the operator asked for. A subresource is
            // left alone: upgrading an image that only exists over http breaks a
            // page that was working, and the top-level document is the request
            // that carries the address.
            if navigationAction.targetFrame?.isMainFrame == true,
               let url = navigationAction.request.url,
               let secure = WardenEngine.upgraded(url) {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: secure))
                return
            }
            decisionHandler(.allow)
            return
        }

        if let url = navigationAction.request.url {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }

    // MARK: - WKUIDelegate

    /// A `target="_blank"` link opens in this view rather than being dropped: the
    /// surface has a tab strip, but a link that silently does nothing reads as a
    /// broken page, so it opens where the operator is looking.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // MARK: - UITextFieldDelegate

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        guard let typed = WardenBrowserViewController.resolve(textField.text ?? "") else { return false }
        load(typed)
        return true
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        textField.selectAll(nil)
    }

    /// The same rule the shell's own field uses: a bare host becomes https, and
    /// anything that is not a host becomes a search.
    static func resolve(_ input: String) -> URL? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        if let url = URL(string: value), let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme), url.host != nil {
            return url
        }
        // A raw string, so the backslashes reach the regex engine as written:
        // an escaped `\.` is a dot, and `\d` is a digit — `\\.` and `\\d`
        // would match a literal backslash and never a host at all.
        let hostLike = value.range(
            of: #"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(/.*)?$"#,
            options: .regularExpression
        ) != nil
        if hostLike { return URL(string: "https://" + value) }
        let query = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
        return URL(string: "https://duckduckgo.com/?q=" + query)
    }
}
