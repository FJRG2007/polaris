import UIKit

/// Where the phone is told which Polaris to open: one field, checked against the server before it is kept, with the
/// reason on screen when it is not one.
final class ServerViewController: UIViewController, UITextFieldDelegate {
    private let done: () -> Void
    private let field = PolarisField()
    private var connect: UIButton!
    private let problem = UILabel()
    private let busy = UIActivityIndicatorView(style: .medium)
    private var attempt = 0

    init(done: @escaping () -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background

        let title = UILabel()
        title.text = String(localized: "server.title")
        title.font = Plex.font(.semibold, 22, .title2)
        title.textColor = Palette.foreground
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true

        let hint = UILabel()
        hint.text = String(localized: "server.hint")
        hint.font = Plex.font(.regular, 15, .subheadline)
        hint.textColor = Palette.muted
        hint.numberOfLines = 0
        hint.adjustsFontForContentSizeCategory = true

        field.setHint("polaris.example.com")
        field.keyboardType = .URL
        field.textContentType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .go
        field.delegate = self

        problem.textColor = Palette.danger
        problem.font = Plex.font(.regular, 14, .footnote)
        problem.adjustsFontForContentSizeCategory = true
        problem.numberOfLines = 0
        problem.isHidden = true

        connect = PolarisButton.primary(String(localized: "server.connect"), UIAction { [weak self] _ in self?.submit() })

        busy.color = Palette.primary
        busy.hidesWhenStopped = true

        let logo = UIImageView(image: UIImage(named: "Logo"))
        logo.contentMode = .scaleAspectFit
        logo.layer.cornerRadius = 16
        logo.clipsToBounds = true
        logo.widthAnchor.constraint(equalToConstant: 64).isActive = true
        logo.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let logoRow = UIStackView(arrangedSubviews: [logo, UIView()])

        let scan = UILabel()
        scan.text = String(localized: "server.scanHint")
        scan.font = Plex.font(.regular, 13, .footnote)
        scan.textColor = Palette.muted
        scan.numberOfLines = 0
        scan.adjustsFontForContentSizeCategory = true

        var rows: [UIView] = [logoRow, title, hint, field, problem, connect, busy, scan]
        // Back to the Polaris open before, when this screen was reached to add another.
        if ServerStore.active != nil {
            rows.append(PolarisButton.ghost(String(localized: "dialog.cancel"), UIAction { [weak self] _ in self?.done() }))
        }
        let stack = UIStackView(arrangedSubviews: rows)
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(24, after: logoRow)
        stack.setCustomSpacing(24, after: hint)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        let guide = view.readableContentGuide
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -160),
            stack.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 16)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        field.becomeFirstResponder()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        submit()
        return true
    }

    private func submit() {
        // The code the desktop app copies, pasted here instead of an address: every server on it, at once.
        if let list = HostList.read(field.text) {
            guard !list.isEmpty else { return show(String(localized: "link.hostsInvalid")) }
            ServerStore.importHosts(list)
            return done()
        }
        guard let origin = ServerAddress.origin(field.text) else {
            show(String(localized: "server.invalid"))
            return
        }
        attempt += 1
        let mine = attempt
        setBusy(true)
        problem.isHidden = true
        Task { @MainActor in
            let verdict = await ServerProbe.probe(origin)
            guard mine == attempt else { return }
            setBusy(false)
            if verdict == .polaris {
                ServerStore.add(origin)
                done()
            } else {
                show(reason(verdict))
            }
        }
    }

    private func reason(_ verdict: ServerProbe.Verdict) -> String {
        switch verdict {
        case .starting: return String(localized: "server.starting")
        case .redirects: return String(localized: "server.redirects")
        case .unreachable: return String(localized: "server.unreachable")
        default: return String(localized: "server.notPolaris")
        }
    }

    private func setBusy(_ on: Bool) {
        on ? busy.startAnimating() : busy.stopAnimating()
        connect.isEnabled = !on
        field.isEnabled = !on
    }

    private func show(_ text: String) {
        problem.text = text
        problem.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}
