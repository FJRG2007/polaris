import UIKit

/// Where the phone is told which Polaris to open: one field, checked against the server before it is kept, with the
/// reason on screen when it is not one.
final class ServerViewController: UIViewController, UITextFieldDelegate {
    private let done: () -> Void
    private let field = UITextField()
    private let connect = UIButton(type: .system)
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
        title.font = .preferredFont(forTextStyle: .title2).bold
        title.textColor = Palette.foreground
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true

        let hint = UILabel()
        hint.text = String(localized: "server.hint")
        hint.font = .preferredFont(forTextStyle: .subheadline)
        hint.textColor = Palette.muted
        hint.numberOfLines = 0
        hint.adjustsFontForContentSizeCategory = true

        field.text = ServerStore.origin
        field.placeholder = "polaris.example.com"
        field.keyboardType = .URL
        field.textContentType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .go
        field.borderStyle = .roundedRect
        field.textColor = Palette.foreground
        field.delegate = self

        problem.textColor = Palette.danger
        problem.font = .preferredFont(forTextStyle: .footnote)
        problem.numberOfLines = 0
        problem.isHidden = true

        var style = UIButton.Configuration.filled()
        style.baseBackgroundColor = Palette.primary
        style.title = String(localized: "server.connect")
        connect.configuration = style
        connect.addAction(UIAction { [weak self] _ in self?.submit() }, for: .primaryActionTriggered)

        busy.color = Palette.primary
        busy.hidesWhenStopped = true

        let stack = UIStackView(arrangedSubviews: [title, hint, field, problem, connect, busy])
        stack.axis = .vertical
        stack.spacing = 12
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
                ServerStore.origin = origin
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

private extension UIFont {
    var bold: UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(.traitBold) else { return self }
        return UIFont(descriptor: descriptor, size: 0)
    }
}
