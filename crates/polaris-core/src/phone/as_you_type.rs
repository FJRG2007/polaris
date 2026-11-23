//! libphonenumber-js's `AsYouType` (with `AsYouTypeState`, `AsYouTypeParser`
//! and `AsYouTypeFormatter`), as `new AsYouType(country).input(text)` runs it.
//! The three JavaScript objects share one `Metadata` whose selected plan each
//! of them changes; here they are one struct with that shared plan in `plan`.

use super::js;
use super::metadata::{self, FormatRef, Plan, PlanId};
use super::parse::{self, Length, PLUS_CHARS, VALID_DIGITS, VALID_PUNCTUATION};
use super::PhoneError;

const DUMMY: &str = "999999999999999";

fn x_times(n: usize) -> String {
    "x".repeat(n)
}

/// `stripNonPairedParens`.
fn strip_non_paired_parens(s: &str) -> String {
    let mut dangling: Vec<usize> = Vec::new();
    for (i, c) in s.char_indices() {
        if c == '(' {
            dangling.push(i);
        } else if c == ')' {
            dangling.pop();
        }
    }
    dangling.push(s.len());
    let mut out = String::new();
    let mut start = 0;
    for index in dangling {
        if start <= index {
            out.push_str(&s[start..index]);
        }
        start = index + 1;
    }
    out
}

/// `cutAndStripNonPairedParens`. Templates hold only ASCII.
fn cut_and_strip(s: &str, cut: usize) -> String {
    let mut cut = cut.min(s.len());
    if s.as_bytes().get(cut) == Some(&b')') {
        cut += 1;
    }
    strip_non_paired_parens(&s[..cut.min(s.len())])
}

/// `populateTemplateWithDigits`.
fn populate(template: &str, position: isize, digits: &str) -> Option<(String, isize)> {
    let mut template = template.to_string();
    let mut position = position;
    for d in digits.chars() {
        let from = usize::try_from(position + 1)
            .unwrap_or(0)
            .min(template.len());
        if !template[from..].contains('x') {
            return None;
        }
        let at = template.find('x')?;
        position = at as isize;
        template.replace_range(at..at + 1, &d.to_string());
    }
    Some((template, position))
}

/// The legacy rewrite in `getTemplateForFormat`: every bracket class without a
/// nested bracket becomes `\d`, then every digit followed by two characters
/// that are neither `,` nor `}` does.
fn legacy_pattern(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut first = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            let next = chars[i + 1..].iter().position(|c| *c == '[' || *c == ']');
            if let Some(offset) = next {
                if chars[i + 1 + offset] == ']' {
                    first.extend(['\\', 'd']);
                    i += offset + 2;
                    continue;
                }
            }
        }
        first.push(chars[i]);
        i += 1;
    }
    let ok = |c: Option<&char>| c.is_some_and(|c| *c != ',' && *c != '}');
    let mut out = String::with_capacity(first.len() * 2);
    for (i, c) in first.iter().enumerate() {
        if c.is_ascii_digit() && ok(first.get(i + 1)) && ok(first.get(i + 2)) {
            out.push_str("\\d");
        } else {
            out.push(*c);
        }
    }
    out
}

/// `PatternParser` + `PatternMatcher` for a leading-digits pattern.
mod pattern {
    #[derive(Debug)]
    pub enum Node {
        Text(Vec<char>),
        Seq(Vec<Node>),
        Or(Vec<Node>),
        Set(Vec<char>),
    }

    struct Ctx {
        or: bool,
        set: bool,
        instructions: Vec<Node>,
        branches: Option<Vec<Node>>,
    }

    fn expand(mut list: Vec<Node>) -> Node {
        if list.len() == 1 {
            list.remove(0)
        } else {
            Node::Seq(list)
        }
    }

    fn find_operator(p: &[char]) -> Option<(usize, usize)> {
        for i in 0..p.len() {
            match p[i] {
                '|' | ')' | '[' | ']' => return Some((i, 1)),
                '(' if p.get(i + 1) == Some(&'?') && p.get(i + 2) == Some(&':') => {
                    return Some((i, 3))
                }
                _ => {}
            }
        }
        None
    }

    fn one_of(p: &[char]) -> Result<Vec<char>, ()> {
        let mut values = Vec::new();
        for i in 0..p.len() {
            if p[i] == '-' {
                if i == 0 || i == p.len() - 1 {
                    return Err(());
                }
                let mut v = p[i - 1] as u32 + 1;
                let last = (p[i + 1] as u32).wrapping_sub(1);
                while v <= last && (p[i + 1] as u32) > 0 {
                    values.push(char::from_u32(v).ok_or(())?);
                    v += 1;
                }
            } else {
                values.push(p[i]);
            }
        }
        Ok(values)
    }

    struct Parser {
        context: Vec<Ctx>,
    }

    impl Parser {
        fn top(&mut self) -> Result<&mut Ctx, ()> {
            self.context.last_mut().ok_or(())
        }

        fn parse_pattern(&mut self, p: &[char]) -> Result<(), ()> {
            if p.is_empty() {
                return Err(());
            }
            let Some((at, len)) = find_operator(p) else {
                if p.iter().any(|c| "()[]?:|".contains(*c)) {
                    return Err(());
                }
                let top = self.top()?;
                top.instructions
                    .extend(p.iter().map(|c| Node::Text(vec![*c])));
                return Ok(());
            };
            let before = &p[..at];
            let right = &p[at + len..];
            match (p[at], len) {
                ('(', 3) => {
                    if !before.is_empty() {
                        self.parse_pattern(before)?;
                    }
                    self.context.push(Ctx {
                        or: true,
                        set: false,
                        instructions: Vec::new(),
                        branches: Some(Vec::new()),
                    });
                }
                (')', _) => {
                    if !self.top()?.or {
                        return Err(());
                    }
                    if !before.is_empty() {
                        self.parse_pattern(before)?;
                    }
                    let top = self.top()?;
                    if top.instructions.is_empty() {
                        return Err(());
                    }
                    let instructions = std::mem::take(&mut top.instructions);
                    let mut branches = top.branches.take().ok_or(())?;
                    branches.push(expand(instructions));
                    self.context.pop();
                    self.top()?.instructions.push(Node::Or(branches));
                }
                ('|', _) => {
                    if !self.top()?.or {
                        return Err(());
                    }
                    if !before.is_empty() {
                        self.parse_pattern(before)?;
                    }
                    let depth = self.context.len();
                    let top = self.top()?;
                    if top.branches.is_none() {
                        if depth == 1 {
                            top.branches = Some(Vec::new());
                        } else {
                            return Err(());
                        }
                    }
                    let instructions = std::mem::take(&mut top.instructions);
                    top.branches.as_mut().ok_or(())?.push(expand(instructions));
                }
                ('[', _) => {
                    if !before.is_empty() {
                        self.parse_pattern(before)?;
                    }
                    self.context.push(Ctx {
                        or: false,
                        set: true,
                        instructions: Vec::new(),
                        branches: None,
                    });
                }
                (']', _) => {
                    if !self.top()?.set {
                        return Err(());
                    }
                    self.context.pop();
                    let set = one_of(before)?;
                    self.top()?.instructions.push(Node::Set(set));
                }
                _ => return Err(()),
            }
            if !right.is_empty() {
                self.parse_pattern(right)?;
            }
            Ok(())
        }
    }

    /// `new PatternParser().parse(pattern)`; `Err` where it throws.
    pub fn parse(pattern: &str) -> Result<Node, ()> {
        let chars: Vec<char> = pattern.chars().collect();
        let mut parser = Parser {
            context: vec![Ctx {
                or: true,
                set: false,
                instructions: Vec::new(),
                branches: None,
            }],
        };
        parser.parse_pattern(&chars)?;
        if parser.context.len() != 1 {
            return Err(());
        }
        let ctx = parser.context.pop().ok_or(())?;
        if let Some(mut branches) = ctx.branches {
            branches.push(expand(ctx.instructions));
            return Ok(Node::Or(branches));
        }
        if ctx.instructions.is_empty() {
            return Err(());
        }
        Ok(expand(ctx.instructions))
    }

    pub enum Outcome {
        Match(usize),
        Partial,
        Overflow,
    }

    /// The matcher's `match(characters, tree, last)`; `None` is `undefined`,
    /// `Err` a throw. `Match` carries how many characters it took.
    pub fn matches(chars: &[char], tree: &Node, last: bool) -> Result<Option<Outcome>, ()> {
        match tree {
            Node::Text(text) => {
                if text.starts_with(chars) {
                    if chars.len() == text.len() {
                        return Ok(Some(Outcome::Match(chars.len())));
                    }
                    return Ok(Some(Outcome::Partial));
                }
                if chars.starts_with(text) {
                    if last && chars.len() > text.len() {
                        return Ok(Some(Outcome::Overflow));
                    }
                    return Ok(Some(Outcome::Match(text.len())));
                }
                Ok(None)
            }
            Node::Seq(list) => {
                let mut rest = chars;
                for (i, sub) in list.iter().enumerate() {
                    let is_last = last && i == list.len() - 1;
                    match matches(rest, sub, is_last)? {
                        None => return Ok(None),
                        Some(Outcome::Overflow) => return Ok(Some(Outcome::Overflow)),
                        Some(Outcome::Match(n)) => {
                            rest = &rest[n.min(rest.len())..];
                            if rest.is_empty() {
                                if i == list.len() - 1 {
                                    return Ok(Some(Outcome::Match(chars.len())));
                                }
                                return Ok(Some(Outcome::Partial));
                            }
                        }
                        Some(Outcome::Partial) => return Ok(Some(Outcome::Partial)),
                    }
                }
                if last {
                    return Ok(Some(Outcome::Overflow));
                }
                Ok(Some(Outcome::Match(chars.len() - rest.len())))
            }
            Node::Or(branches) => {
                let mut partial = false;
                for branch in branches {
                    match matches(chars, branch, last)? {
                        Some(Outcome::Overflow) => return Ok(Some(Outcome::Overflow)),
                        Some(Outcome::Match(n)) => return Ok(Some(Outcome::Match(n))),
                        Some(Outcome::Partial) => partial = true,
                        None => {}
                    }
                }
                Ok(if partial {
                    Some(Outcome::Partial)
                } else {
                    None
                })
            }
            Node::Set(set) => {
                for c in set {
                    if chars.first() == Some(c) {
                        if chars.len() == 1 {
                            return Ok(Some(Outcome::Match(1)));
                        }
                        if last {
                            return Ok(Some(Outcome::Overflow));
                        }
                        return Ok(Some(Outcome::Match(1)));
                    }
                }
                Ok(None)
            }
        }
    }
}

fn type_error(property: &str) -> PhoneError {
    PhoneError::type_error(format!(
        "Cannot read properties of undefined (reading '{property}')"
    ))
}

#[derive(Default)]
struct State {
    international: bool,
    missing_plus: bool,
    idd: Option<String>,
    calling_code: Option<String>,
    digits: String,
    nsn: String,
    nsn_modified: bool,
    national_prefix: Option<String>,
    prefix_not_np: Option<String>,
    country: Option<&'static str>,
}

fn truthy(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

impl State {
    fn national_digits(&self) -> String {
        if self.international {
            let skip = self.idd.as_ref().map_or(0, String::len)
                + self.calling_code.as_ref().map_or(0, String::len);
            return self.digits.get(skip..).unwrap_or("").to_string();
        }
        self.digits.clone()
    }

    fn digits_without_idd(&self) -> String {
        if self.international {
            if let Some(idd) = truthy(&self.idd) {
                return self.digits.get(idd.len()..).unwrap_or("").to_string();
            }
        }
        self.digits.clone()
    }

    fn reset_nsn(&mut self) {
        self.nsn = self.national_digits();
        self.nsn_modified = false;
        self.national_prefix = None;
        self.prefix_not_np = None;
    }
}

struct AsYouType {
    default_country: Option<&'static str>,
    plan: Option<&'static Plan>,
    state: State,
    // Formatter.
    chosen: Option<FormatRef>,
    template: Option<String>,
    populated: Option<String>,
    populated_pos: isize,
    is_nanp: bool,
    matching: Vec<FormatRef>,
    // Parser.
    parser_has_plan: bool,
    could_extract_another: bool,
    has_extracted_nsn: bool,
}

impl AsYouType {
    fn new(default_country: Option<&'static str>) -> Result<Self, PhoneError> {
        let mut this = AsYouType {
            default_country,
            plan: None,
            state: State::default(),
            chosen: None,
            template: None,
            populated: None,
            populated_pos: -1,
            is_nanp: false,
            matching: Vec::new(),
            parser_has_plan: false,
            could_extract_another: false,
            has_extracted_nsn: false,
        };
        this.state.country = default_country;
        this.set_calling_code(None)?;
        Ok(this)
    }

    fn reset_format(&mut self) {
        self.chosen = None;
        self.template = None;
        self.populated = None;
        self.populated_pos = -1;
    }

    /// `state.setCallingCode` and the `onCallingCodeChange` it fires.
    fn set_calling_code(&mut self, code: Option<String>) -> Result<(), PhoneError> {
        self.state.calling_code = code;
        let key = self
            .state
            .country
            .map(str::to_string)
            .or_else(|| self.state.calling_code.clone());
        self.plan = match key {
            Some(k) => metadata::select(&k)?.map(PlanId::plan),
            None => None,
        };
        self.formatter_reset()?;
        match self.plan {
            Some(plan) => {
                self.parser_has_plan = true;
                self.could_extract_another = plan.np_for_parsing.is_some_and(|p| {
                    p.chars()
                        .any(|c| !(c.is_ascii_digit() || c == '[' || c == ']'))
                });
            }
            None => {
                self.parser_has_plan = false;
                self.could_extract_another = false;
            }
        }
        Ok(())
    }

    fn formatter_reset(&mut self) -> Result<(), PhoneError> {
        self.reset_format();
        match self.plan {
            Some(plan) => {
                self.is_nanp = plan.calling_code == "1";
                self.matching = FormatRef::all(plan);
                if !self.state.nsn.is_empty() {
                    self.narrow_down();
                }
            }
            None => {
                self.is_nanp = false;
                self.matching = Vec::new();
            }
        }
        Ok(())
    }

    fn start_international(
        &mut self,
        country: Option<&'static str>,
        code: Option<String>,
    ) -> Result<(), PhoneError> {
        self.state.international = true;
        self.state.country = country;
        self.set_calling_code(code)
    }

    fn format_suits(&self, f: &FormatRef) -> bool {
        let np = truthy(&self.state.national_prefix).is_some();
        if np && !f.uses_national_prefix() && !f.np_optional() {
            return false;
        }
        if !self.state.international && !np && f.np_mandatory() {
            return false;
        }
        true
    }

    fn format_matches(f: &FormatRef, leading: &str, index: usize) -> bool {
        let count = f.format.leading.len();
        if count == 0 {
            return true;
        }
        let pattern = f.format.leading[index.min(count - 1)];
        if leading.len() < 3 {
            let chars: Vec<char> = leading.chars().collect();
            if chars.is_empty() {
                return true;
            }
            return match pattern::parse(pattern)
                .and_then(|tree| pattern::matches(&chars, &tree, true))
            {
                Ok(found) => found.is_some(),
                Err(()) => true,
            };
        }
        js::test(&format!("^({pattern})"), leading)
    }

    fn narrow_down(&mut self) {
        let leading = self.state.nsn.clone();
        let index = leading.len().saturating_sub(3);
        let matching = std::mem::take(&mut self.matching);
        self.matching = matching
            .into_iter()
            .filter(|f| self.format_suits(f) && Self::format_matches(f, &leading, index))
            .collect();
        if let Some(chosen) = self.chosen {
            if !self.matching.contains(&chosen) {
                self.reset_format();
            }
        }
    }

    fn should_try_np_rule(&self, f: &FormatRef) -> bool {
        if f.np_rule().is_some() {
            let uses = f.uses_national_prefix();
            let np = truthy(&self.state.national_prefix).is_some();
            return (uses && np) || (!uses && !self.state.international);
        }
        false
    }

    fn separator_after_np(&self, f: &FormatRef) -> &'static str {
        if self.is_nanp {
            return " ";
        }
        if f.np_rule()
            .is_some_and(|r| r.contains('-') || r.contains(' '))
        {
            return " ";
        }
        ""
    }

    fn international_prefix(&self, spacing: bool) -> String {
        if let Some(idd) = truthy(&self.state.idd) {
            return if spacing {
                format!("{idd} ")
            } else {
                idd.to_string()
            };
        }
        if self.state.missing_plus {
            return String::new();
        }
        "+".into()
    }

    fn set_template(&mut self, template: String) -> Result<(), PhoneError> {
        self.populated = Some(template.clone());
        self.populated_pos = -1;
        self.template = Some(if self.state.international {
            let code = self
                .state
                .calling_code
                .as_ref()
                .ok_or_else(|| type_error("length"))?;
            let prefix: String = self
                .international_prefix(true)
                .chars()
                .map(|c| {
                    if c.is_ascii_digit() || c == '+' {
                        'x'
                    } else {
                        c
                    }
                })
                .collect();
            format!("{prefix}{} {template}", x_times(code.len()))
        } else {
            template
        });
        Ok(())
    }

    /// `formatNationalNumber` of `AsYouTypeFormatter.complete`.
    fn complete_national(&self, f: &FormatRef, use_np_rule: bool) -> Option<String> {
        let mut formatted =
            parse::format_using(&self.state.nsn, f, self.state.international, use_np_rule);
        if !use_np_rule {
            if let Some(np) = truthy(&self.state.national_prefix) {
                formatted = format!("{np}{}{formatted}", self.separator_after_np(f));
            } else if let Some(prefix) = truthy(&self.state.prefix_not_np) {
                formatted = format!("{prefix} {formatted}");
            }
        }
        (parse::parse_digits(&formatted) == self.state.national_digits()).then_some(formatted)
    }

    fn format_complete(&self, f: &FormatRef) -> Option<String> {
        if !js::matches_entirely(&self.state.nsn, f.format.pattern) {
            return None;
        }
        if self.should_try_np_rule(f) {
            if let Some(found) = self.complete_national(f, true).filter(|s| !s.is_empty()) {
                return Some(found);
            }
        }
        self.complete_national(f, false)
    }

    fn template_for(&self, f: &FormatRef) -> Result<Option<String>, PhoneError> {
        let pattern = legacy_pattern(f.format.pattern);
        let Some(found) = js::re(&pattern).find(DUMMY) else {
            return Err(PhoneError::type_error(
                "Cannot read properties of null (reading '0')".into(),
            ));
        };
        let mut digits = found.as_str().to_string();
        let nsn = &self.state.nsn;
        if nsn.len() > digits.len() {
            return Ok(None);
        }
        let dummy: String = nsn
            .chars()
            .map(|c| if c.is_ascii_digit() { '9' } else { c })
            .collect();
        if js::test(&format!("^{pattern}$"), &dummy) {
            digits = dummy;
        }
        let international = self.state.international;
        let mut number_format = if international {
            f.international_format()
        } else {
            f.format.format
        }
        .to_string();
        let mut np_included = false;
        let np = truthy(&self.state.national_prefix);
        if self.should_try_np_rule(f) {
            let rule = f.np_rule().unwrap_or("");
            let with_np = js::replace_first("(\\$\\d)", &number_format, rule);
            // `(nationalPrefix || '') + parseDigits('$1')`: the `1` of `$1` is a digit.
            if parse::parse_digits(rule) == format!("{}1", np.unwrap_or("")) {
                number_format = with_np;
                np_included = true;
                if let Some(np) = np {
                    for _ in 0..js::utf16_len(np) {
                        number_format = js::replace_first("\\d", &number_format, "x");
                    }
                }
            }
        }
        let mut template = js::replace_first(&pattern, &digits, &number_format).replace('9', "x");
        if !np_included {
            if let Some(prefix) = truthy(&self.state.prefix_not_np) {
                template = format!("{} {template}", x_times(prefix.len()));
            } else if let Some(np) = np {
                template = format!(
                    "{}{}{template}",
                    x_times(np.len()),
                    self.separator_after_np(f)
                );
            }
        }
        if international {
            template = parse::international_separators(&template);
        }
        Ok(Some(template))
    }

    fn choose_format(&mut self) -> Result<Option<FormatRef>, PhoneError> {
        let non_altering = format!(
            "[{VALID_PUNCTUATION}]*\\$1[{VALID_PUNCTUATION}]*(\\$\\d[{VALID_PUNCTUATION}]*)*$"
        );
        for f in self.matching.clone() {
            if self.chosen == Some(f) {
                break;
            }
            let text = if self.state.international {
                f.international_format()
            } else {
                f.format.format
            };
            if !js::test(&non_altering, text) {
                continue;
            }
            let template = if f.format.pattern.contains('|') {
                None
            } else {
                self.template_for(&f)?
            };
            match template.filter(|t| !t.is_empty()) {
                Some(t) => {
                    self.set_template(t)?;
                    self.chosen = Some(f);
                    break;
                }
                None => self.matching.retain(|m| *m != f),
            }
        }
        if self.chosen.is_none() {
            self.reset_format();
        }
        Ok(self.chosen)
    }

    fn format_next_digits(&mut self, digits: &str) -> Option<String> {
        let populated = self.populated.clone().unwrap_or_default();
        match populate(&populated, self.populated_pos, digits) {
            None => {
                self.reset_format();
                None
            }
            Some((template, position)) => {
                let out = cut_and_strip(&template, usize::try_from(position + 1).unwrap_or(0));
                self.populated = Some(template);
                self.populated_pos = position;
                Some(out)
            }
        }
    }

    /// `AsYouTypeFormatter#format`.
    fn format(&mut self, next: &str) -> Result<Option<String>, PhoneError> {
        let plan = self.plan.ok_or_else(|| type_error("type"))?;
        if parse::check_length(&self.state.nsn, plan) == Length::IsPossible {
            for f in self.matching.clone() {
                if let Some(done) = self.format_complete(&f).filter(|s| !s.is_empty()) {
                    self.reset_format();
                    self.chosen = Some(f);
                    let template: String = done
                        .chars()
                        .map(|c| if c.is_ascii_digit() { 'x' } else { c })
                        .collect();
                    self.set_template(template)?;
                    self.populated = Some(done.clone());
                    self.populated_pos = self
                        .template
                        .as_deref()
                        .and_then(|t| t.rfind('x'))
                        .map_or(-1, |p| p as isize);
                    return Ok(Some(done));
                }
            }
        }
        let previous = self.chosen;
        let Some(newly) = self.choose_format()? else {
            return Ok(None);
        };
        if Some(newly) == previous {
            Ok(self.format_next_digits(next))
        } else {
            let digits = self.state.national_digits();
            Ok(self.format_next_digits(&digits))
        }
    }

    fn determine_country(&mut self) -> Result<(), PhoneError> {
        let ambiguous = self
            .state
            .calling_code
            .as_deref()
            .and_then(metadata::countries_for_code)
            .is_some_and(|l| l.len() > 1);
        if self.state.country.is_some() && !ambiguous {
            return Ok(());
        }
        let country = match (&self.state.calling_code, self.state.international) {
            (Some(code), true) => parse::country_by_calling_code(code, &self.state.nsn),
            _ => None,
        };
        if country != self.state.country {
            self.state.country = country;
            if let Some(c) = country {
                self.plan = metadata::select(c)?.map(PlanId::plan);
            }
        }
        Ok(())
    }

    fn on_nsn_change(&mut self) -> Result<(), PhoneError> {
        self.determine_country()?;
        self.formatter_reset()
    }

    fn on_extracted(
        &mut self,
        extracted: parse::Extracted,
        national_digits: &str,
    ) -> Result<(), PhoneError> {
        let nsn = extracted.national;
        let mut modified = false;
        let mut prefix_not_np = None;
        match national_digits.rfind(nsn.as_str()) {
            Some(i) if i == national_digits.len() - nsn.len() => {
                let prefix = &national_digits[..i];
                if !prefix.is_empty() && Some(prefix) != extracted.national_prefix.as_deref() {
                    prefix_not_np = Some(prefix.to_string());
                }
            }
            _ => modified = true,
        }
        self.state.national_prefix = extracted.national_prefix;
        self.state.nsn = nsn;
        self.state.nsn_modified = modified;
        self.state.prefix_not_np = prefix_not_np;
        self.has_extracted_nsn = true;
        self.on_nsn_change()
    }

    fn extract_nsn(&mut self, national_digits: &str) -> Result<bool, PhoneError> {
        if !self.parser_has_plan {
            return Ok(false);
        }
        let Some(plan) = self.plan else {
            return Err(type_error("nationalPrefixForParsing"));
        };
        let extracted = parse::extract_national_incomplete(national_digits, plan);
        if extracted.national == national_digits {
            return Ok(false);
        }
        self.on_extracted(extracted, national_digits)?;
        Ok(true)
    }

    fn extract_another_nsn(&mut self, national_digits: &str) -> Result<bool, PhoneError> {
        if !self.has_extracted_nsn {
            return self.extract_nsn(national_digits);
        }
        if !self.could_extract_another {
            return Ok(false);
        }
        let Some(plan) = self.plan else {
            return Err(type_error("nationalPrefixForParsing"));
        };
        let extracted = parse::extract_national_incomplete(national_digits, plan);
        if extracted.national == self.state.nsn {
            return Ok(false);
        }
        self.on_extracted(extracted, national_digits)?;
        Ok(true)
    }

    fn parser_start_international(
        &mut self,
        country: Option<&'static str>,
        code: Option<String>,
    ) -> Result<(), PhoneError> {
        self.start_international(country, code)?;
        if !self.state.nsn.is_empty() {
            self.state.reset_nsn();
            self.on_nsn_change()?;
            self.has_extracted_nsn = false;
        }
        Ok(())
    }

    fn extract_idd_prefix(&mut self) -> Result<bool, PhoneError> {
        if self.state.international || truthy(&self.state.idd).is_some() {
            return Ok(false);
        }
        let digits = self.state.digits.clone();
        match parse::strip_idd_prefix(&digits, self.default_country)? {
            Some(rest) if rest != digits => {
                self.state.idd = Some(digits[..digits.len() - rest.len()].to_string());
                self.parser_start_international(None, None)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn extract_calling_code(&mut self) -> Result<bool, PhoneError> {
        let number = format!("+{}", self.state.digits_without_idd());
        let found =
            parse::extract_calling_code(&number, self.state.country.or(self.default_country))?;
        match found.code {
            Some(code) => {
                self.set_calling_code(Some(code))?;
                self.state.nsn = found.number.unwrap_or_default();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn fix_missing_plus(&mut self) -> Result<bool, PhoneError> {
        if self.state.international {
            return Ok(false);
        }
        let digits = self.state.digits.clone();
        let found =
            parse::extract_code_without_plus(&digits, self.state.country.or(self.default_country))?;
        match found {
            Some((code, _)) => {
                self.state.missing_plus = true;
                let country = self.state.country;
                self.parser_start_international(country, Some(code.to_string()))?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn extract_code_and_nsn(&mut self) -> Result<(), PhoneError> {
        if self.extract_calling_code()? {
            let digits = self.state.national_digits();
            self.extract_nsn(&digits)?;
        }
        Ok(())
    }

    fn re_extract_nsn(&mut self) -> Result<bool, PhoneError> {
        let digits = self.state.national_digits();
        if self.extract_another_nsn(&digits)? {
            return Ok(true);
        }
        if self.extract_idd_prefix()? {
            self.extract_code_and_nsn()?;
            return Ok(true);
        }
        if self.fix_missing_plus()? {
            self.extract_code_and_nsn()?;
            return Ok(true);
        }
        Ok(false)
    }

    fn input_digits(&mut self, next: &str) -> Result<(), PhoneError> {
        let before = self.state.digits.len();
        let three = before < 3 && before + next.len() >= 3;
        self.state.digits.push_str(next);
        if three {
            self.extract_idd_prefix()?;
        }
        if self.state.international && self.state.calling_code.is_none() {
            if !self.extract_calling_code()? {
                return Ok(());
            }
        } else {
            self.state.nsn.push_str(next);
        }
        if !self.state.international && !self.has_extracted_nsn {
            let digits = self.state.national_digits();
            self.extract_nsn(&digits)?;
        }
        Ok(())
    }

    fn full_number(&self, national: &str) -> String {
        if self.state.international {
            let prefix =
                |text: String| format!("{}{text}", self.international_prefix(!text.is_empty()));
            return match self.state.calling_code.as_deref().filter(|c| !c.is_empty()) {
                None => prefix(self.state.digits_without_idd()),
                Some(code) if national.is_empty() => prefix(code.to_string()),
                Some(code) => prefix(format!("{code} {national}")),
            };
        }
        national.to_string()
    }

    fn non_formatted(&self) -> String {
        let national = if self.state.nsn_modified {
            self.state.national_digits()
        } else {
            let prefix = truthy(&self.state.prefix_not_np).or(truthy(&self.state.national_prefix));
            match prefix {
                Some(p) => format!("{p}{}", self.state.nsn),
                None => self.state.nsn.clone(),
            }
        };
        self.full_number(&national)
    }

    fn input(&mut self, text: &str) -> Result<String, PhoneError> {
        let (formatted_digits, has_plus) = extract_formatted_digits_and_plus(text);
        let digits = parse::parse_digits(&formatted_digits);
        let mut just_leading_plus = false;
        if has_plus && self.state.digits.is_empty() {
            self.start_international(None, None)?;
            just_leading_plus = digits.is_empty();
        }
        if !digits.is_empty() {
            self.input_digits(&digits)?;
        }
        if just_leading_plus {
            return Ok("+".into());
        }
        if digits.is_empty() {
            return Ok(String::new());
        }
        self.determine_country()?;
        if !self.state.nsn.is_empty() {
            self.narrow_down();
        }
        let mut formatted = None;
        if self.plan.is_some() {
            formatted = self.format(&digits)?;
        }
        if formatted.is_none() && self.re_extract_nsn()? {
            self.determine_country()?;
            let national = self.state.national_digits();
            if !national.is_empty() {
                formatted = self.format(&national)?;
            }
        }
        Ok(match formatted.filter(|f| !f.is_empty()) {
            Some(f) => self.full_number(&f),
            None => self.non_formatted(),
        })
    }
}

/// `extractFormattedDigitsAndPlus`.
fn extract_formatted_digits_and_plus(text: &str) -> (String, bool) {
    let part = format!("(?:[{PLUS_CHARS}][{VALID_PUNCTUATION}{VALID_DIGITS}]*|[{VALID_PUNCTUATION}{VALID_DIGITS}]+)");
    let extracted = match js::search(&part, text) {
        None => String::new(),
        Some(start) => {
            let mut rest = &text[start..];
            let has_plus = rest.starts_with('+');
            if has_plus {
                rest = &rest[1..];
            }
            let after = format!("[^{VALID_PUNCTUATION}{VALID_DIGITS}]+.*$");
            let end = js::search(&after, rest).unwrap_or(rest.len());
            let kept = &rest[..end];
            if has_plus {
                format!("+{kept}")
            } else {
                kept.to_string()
            }
        }
    };
    let (digits, has_plus) = match extracted.strip_prefix('+') {
        Some(rest) => (rest.to_string(), true),
        None => (extracted, false),
    };
    let valid = format!("^[{VALID_PUNCTUATION}{VALID_DIGITS}]+$");
    if js::test(&valid, &digits) {
        (digits, has_plus)
    } else {
        (String::new(), has_plus)
    }
}

/// `new AsYouType(country).input(text)`, `country` already checked against the
/// metadata (an own key, or `None`).
pub fn format_as_typed(text: &str, country: Option<&'static str>) -> Result<String, PhoneError> {
    AsYouType::new(country)?.input(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_rewrite() {
        assert_eq!(legacy_pattern("(\\d{3})(\\d{4})"), "(\\d{3})(\\d{4})");
        assert_eq!(
            legacy_pattern("([2-9]\\d{2})(1)(\\d{3,4})"),
            "(\\d\\d{2})(\\d)(\\d{3,4})"
        );
    }

    #[test]
    fn parens() {
        assert_eq!(strip_non_paired_parens("(12) (3"), "(12) 3");
        assert_eq!(cut_and_strip("(xxx) xxx", 4), "(xxx)");
    }

    #[test]
    fn leading_digit_matcher() {
        let tree = pattern::parse("1(?:[2-4]|5)").unwrap();
        assert!(matches!(
            pattern::matches(&['1'], &tree, true),
            Ok(Some(pattern::Outcome::Partial))
        ));
        assert!(matches!(
            pattern::matches(&['1', '3'], &tree, true),
            Ok(Some(pattern::Outcome::Match(2)))
        ));
        assert!(matches!(pattern::matches(&['2'], &tree, true), Ok(None)));
        assert!(pattern::parse("1?").is_err());
    }
}
