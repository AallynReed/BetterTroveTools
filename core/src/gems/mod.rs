//! backend/gems_and_builds: Gem Builds, the Gem Evaluator, the Gem Simulator and the
//! Star Chart, plus the models and maths they share (utils/gem_engine.py,
//! models/trove/gem_*.py, gems.py, builds.py).

mod builds;
mod constants;
mod engine;
mod evaluator;
mod model;
mod py;
mod pyd;
mod simulator;
mod star_chart;

#[cfg(test)]
mod tests;

use crate::{Args, Cmd};

pub fn commands() -> Vec<Cmd> {
    let mut all = Vec::new();
    all.extend(builds::commands());
    all.extend(evaluator::commands());
    all.extend(simulator::commands());
    all.extend(star_chart::commands());
    all
}

/// The `TypeError` Python raised when the page passed the wrong number of arguments.
fn arity(a: &Args, func: &str, params: &[&str], required: usize) -> anyhow::Result<()> {
    let given = a.len();
    if given < required {
        let missing: Vec<String> = params[given..required].iter().map(|p| format!("'{p}'")).collect();
        let names = match missing.split_last() {
            Some((last, [])) => last.clone(),
            Some((last, [only])) => format!("{only} and {last}"),
            Some((last, rest)) => format!("{}, and {last}", rest.join(", ")),
            None => String::new(),
        };
        let n = missing.len();
        anyhow::bail!("{func}() missing {n} required positional argument{}: {names}", if n == 1 { "" } else { "s" });
    }
    if given > params.len() {
        let takes = if required == params.len() { params.len().to_string() } else { format!("from {required} to {}", params.len()) };
        let plural = if params.len() == 1 && required == params.len() { "" } else { "s" };
        let verb = if given == 1 { "was" } else { "were" };
        anyhow::bail!("{func}() takes {takes} positional argument{plural} but {given} {verb} given");
    }
    Ok(())
}
