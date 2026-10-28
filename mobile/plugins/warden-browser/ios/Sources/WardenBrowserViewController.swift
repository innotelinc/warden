import UIKit
import WebKit

/**
 The browser surface: a web view with its own chrome.

 Everything here is deliberately part of the app rather than the system's browser
 view, because a browser that hides its own address bar is not a browser. The
 chrome is one row — back, forward, reload, an editable address field, and a way
 out — plus a progress line, so a page gets the rest of the screen.
 */
final class WardenBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UITextFieldDelegate {

    var onEvent: ((String, [String: Any]) -> Void)?
    var onDismiss: (() -> Void)?

    private let startURL: URL
    private var webView: WKWebView!
    private let addressField = UITextField()
    private let backButton = UIButton(type: .system)
    private let forwardButton = UIButton(type: .system)
    private let reloadButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let hostLabel = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var progressObservation: NSKeyValueObservation?

    init(startURL: URL) {
        self.startURL = startURL
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

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        configureChrome()
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: progress.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
            let value = Float(view.estimatedProgress)
            self?.progress.setProgress(value, animated: true)
            self?.progress.isHidden = value >= 1
        }

        // The rules are compiled, not fetched, so this is the one moment they
        // can be attached. The first page waits for them: loading first and
        // attaching afterwards leaves the page the operator opened unfiltered.
        WardenAdBlocker.install(on: configuration.userContentController) { [weak self] in
            guard let strongSelf = self else { return }
            strongSelf.load(strongSelf.startURL)
        }
    }

    // MARK: - Chrome

    private func configureChrome() {
        let bar = UIStackView()
        bar.axis = .horizontal
        bar.alignment = .center
        bar.spacing = 6
        bar.translatesAutoresizingMaskIntoConstraints = false

        style(backButton, system: "chevron.left", accessibility: "Back")
        style(forwardButton, system: "chevron.right", accessibility: "Forward")
        style(reloadButton, system: "arrow.clockwise", accessibility: "Reload")
        backButton.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forwardButton.addTarget(self, action: #selector(goForward), for: .touchUpInside)
        reloadButton.addTarget(self, action: #selector(reload), for: .touchUpInside)

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

        doneButton.setTitle("Done", for: .normal)
        doneButton.setTitleColor(UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1), for: .normal)
        doneButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        bar.addArrangedSubview(doneButton)
        bar.addArrangedSubview(backButton)
        bar.addArrangedSubview(forwardButton)
        bar.addArrangedSubview(addressField)
        bar.addArrangedSubview(reloadButton)

        hostLabel.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
        hostLabel.textColor = UIColor(white: 0.62, alpha: 1)
        hostLabel.translatesAutoresizingMaskIntoConstraints = false

        progress.trackTintColor = .clear
        progress.progressTintColor = UIColor(red: 0.31, green: 0.89, blue: 0.76, alpha: 1)
        progress.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(bar)
        view.addSubview(hostLabel)
        view.addSubview(progress)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),

            hostLabel.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 5),
            hostLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),

            progress.topAnchor.constraint(equalTo: hostLabel.bottomAnchor, constant: 5),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progress.heightAnchor.constraint(equalToConstant: 2)
        ])

        addressField.heightAnchor.constraint(equalToConstant: 34).isActive = true
    }

    private func style(_ button: UIButton, system name: String, accessibility: String) {
        button.setImage(UIImage(systemName: name), for: .normal)
        button.tintColor = UIColor(white: 0.85, alpha: 1)
        button.accessibilityLabel = accessibility
        button.widthAnchor.constraint(equalToConstant: 30).isActive = true
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

    @objc private func close() {
        dismiss(animated: true) { [weak self] in self?.onDismiss?() }
    }

    private func syncChrome() {
        let url = webView.url ?? startURL
        addressField.text = url.absoluteString
        hostLabel.text = url.host ?? ""
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
        backButton.alpha = webView.canGoBack ? 1 : 0.35
        forwardButton.alpha = webView.canGoForward ? 1 : 0.35
        onEvent?("navigated", ["url": url.absoluteString, "title": webView.title ?? ""])
    }

    private func showFailure(_ message: String) {
        let escaped = message.replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript(
            """
            document.body.innerHTML = '<div style="font:14px/1.6 -apple-system,sans-serif;color:#7b8a9d;padding:22px">' +
              '<b style="color:#dbe5f1;display:block;margin-bottom:8px">This page could not be opened</b>' +
              '\(escaped)' +
            '</div>';
            """,
            completionHandler: nil
        )
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        progress.isHidden = false
        syncChrome()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.isHidden = true
        syncChrome()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        progress.isHidden = true
        showFailure(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        progress.isHidden = true
        showFailure(error.localizedDescription)
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
    /// shell has no tab strip on this surface, and a link that does nothing reads
    /// as a broken page.
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
        let hostLike = value.range(
            of: #"^[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(:\d+)?(/.*)?$"#,
            options: .regularExpression
        ) != nil
        if hostLike { return URL(string: "https://" + value) }
        let query = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
        return URL(string: "https://duckduckgo.com/?q=" + query)
    }
}
