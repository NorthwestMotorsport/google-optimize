import weightedRandom from 'weighted-random';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';

import experiments from '<%= options.experimentsDir %>';
const MAX_AGE = <%= options.maxAge %>

export default function (ctx, inject) {
  ctx.app.router.beforeEach((to, from, next) => {
    if (process.client) {
      trackExperiment(ctx, to);
      inject('exp', ctx.experiment);
    }

    next();
  });

  trackExperiment(ctx);
  inject('exp', ctx.experiment);
}

function trackExperiment(ctx, toRoute) {
  // Assign experiment and variant to user
  assignExperiment(ctx, toRoute);

  // Google optimize integration
  googleOptimize(ctx);
}

function assignExperiment(ctx, toRoute) {
  let curRouteName = (toRoute) ? toRoute.name : ctx.route.name;

  // Choose experiment and variant
  let experimentIndex = -1
  let experiment = {}
  let variantIndexes = []
  let classes = []
  let manuallyAssigned = false;
  let index;

  if (ctx.query.experiment) {
    let expSplitArr = ctx.query.experiment.split('-')

    if (expSplitArr.length === 3) {Ò
      let expName = expSplitArr[1];
      let expVariantIndex = parseInt(expSplitArr[2]);

      // check if name and route matches
      experimentIndex = experiments.findIndex(exp => exp.name === expName && exp.routeName.includes(curRouteName));
      experiment = experiments[experimentIndex];

      if (experiment && expVariantIndex >= 0 && experiment.variants.length > expVariantIndex) {
        manuallyAssigned = true;
        index = expVariantIndex;
        variantIndexes = [expVariantIndex];

        // Compute global classes to be injected
        classes = variantIndexes.map(index => 'exp-' + experiment.name + '-' + index)

        // set cookie
        setCookie(ctx, `exp-${curRouteName}`, `${experiment.experimentID}.${variantIndexes.join('-')}`, experiment.maxAge)
      }
    }
  }

  // Try to restore from cookie
  const cookie = getCookie(ctx, `exp-${curRouteName}`) || ''; // experimentID.var1-var2
  const [cookieExp, cookieVars] = cookie.split('.');

  if (cookieExp && cookieVars && !manuallyAssigned) {
    // Try to find experiment with that id
    experimentIndex = experiments.findIndex(exp => exp.experimentID === cookieExp)
    experiment = experiments[experimentIndex]

    // Variant indexes
    variantIndexes = cookieVars.split('-').map(v => parseInt(v))
  }

  if (!manuallyAssigned) {
    // Choose one experiment
    const experimentWeights = experiments.map(exp => exp.weight === undefined ? 1 : exp.weight);
    let retries = experiments.length;

    while (experimentIndex === -1 && retries-- > 0) {
      experimentIndex = weightedRandom(experimentWeights);
      experiment = experiments[experimentIndex];

      // Check if current user is eligible for experiment
      if (typeof experiment.isEligible === 'function') {
        let routeObj = (toRoute) ? toRoute : ctx.route;

        if (!experiment.isEligible(routeObj)) {
          // Try another one
          experimentWeights[experimentIndex] = 0;
          experimentIndex = -1;
        }
      }
    }

    if (experimentIndex !== -1) {
      // Validate variantIndexes against experiment (coming from cookie)
      variantIndexes = variantIndexes.filter(index => experiment.variants[index]);

      // Choose enough variants
      const variantWeights = experiment.variants.map(variant => variant.weight === undefined ? 1 : variant.weight);

      while (variantIndexes.length < (experiment.sections || 1)) {
        index = weightedRandom(variantWeights);
        variantWeights[index] = 0;
        variantIndexes.push(index);
      }

      // Write exp cookie if changed
      const expCookie = experiment.experimentID + '.' + variantIndexes.join('-');

      if (cookie !== expCookie) {
        setCookie(ctx, `exp-${curRouteName}`, expCookie, experiment.maxAge);
      }

      // Compute global classes to be injected
      classes = variantIndexes.map(index => 'exp-' + experiment.name + '-' + index);
    } else {
      // No active experiment
      experiment = {};
      variantIndexes = [];
      classes = [];
    }
  }

  ctx.experiment = {
    $experimentIndex: experimentIndex,
    $variantIndexes: variantIndexes,
    $activeVariants: variantIndexes.map(index => experiment.variants[index]),
    $classes: classes,
    ...experiment
  }
}

function getCookie(ctx, name) {
  if (process.server && !ctx.req) {
    return;
  }

  // Get and parse cookies
  const cookieStr = process.client ? document.cookie : ctx.req.headers.cookie;
  const cookies = parseCookie(cookieStr || '') || {};

  return cookies[name];
}

function setCookie(ctx, name, value, maxAge = MAX_AGE) {
  const serializedCookie = serializeCookie(name, value, {
    path: '/',
    maxAge
  });

  if (process.client) {
    // Set in browser
    document.cookie = serializedCookie;
  } else if (process.server && ctx.res) {
    // Send Set-Cookie header from server side
    const prev = ctx.res.getHeader('Set-Cookie');
    let value = serializedCookie;

    if (prev) {
      value = Array.isArray(prev) ? prev.concat(serializedCookie)
        : [prev, serializedCookie]
    }

    ctx.res.setHeader('Set-Cookie', value);
  }
}

// https://developers.google.com/optimize/devguides/experiments
function googleOptimize({ experiment }) {
  if (process.server || !window.dataLayer || !experiment || !experiment.experimentID) {
    return;
  }

  //const exp = experiment.experimentID + '.' + experiment.$variantIndexes.join('-')
  //window.ga('set', 'exp', exp)

  window.dataLayer.push({
    expId: experiment.experimentID,
    expVar: experiment.$variantIndexes.join('-')
  });
}
