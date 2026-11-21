'use strict';

//
//  Who owns a view, and what state its form is in.
//
//  - view -> its form (ViewController.addView())
//  - form -> its menu: resolved when asked (isFormOfMenu()), as one of the
//    menu's viewControllers. Modules put forms there through
//    addViewController() (the prep*() helpers, standardMCIReadyHandler(),
//    promptForInput()) and also by assigning them directly.
//  - per form: inactive (deactivate(), or cover()), covered (cover(), with
//    its background draw suspend token) and destroyed (destroy(): terminal)
//
//  Kept here, in module-private weak collections, rather than as properties,
//  so no name is taken from a mod's View, ViewController or MenuModule
//  subclass, and so view.js can read it without requiring
//  view_controller.js (which requires view.js).
//
//  A view with no form, or a form no menu holds (a theme's temporary prompt
//  form, a mod's bare view), is owner-less: see View.suspendBackgroundDraw().
//

const viewForms = new WeakMap();
const inactiveForms = new WeakSet();
const coverTokens = new WeakMap();
const destroyedForms = new WeakSet();

function setViewForm(view, form) {
    if (view && form) {
        viewForms.set(view, form);
    }
}

function getViewForm(view) {
    return viewForms.get(view) || null;
}

//  True if |form| is one of |menu|'s forms (its viewControllers), now
function isFormOfMenu(form, menu) {
    if (!form || !menu || !menu.viewControllers) {
        return false;
    }
    const forms = menu.viewControllers;
    for (const name in forms) {
        if (forms[name] === form) {
            return true;
        }
    }
    return false;
}

function setFormInactive(form, inactive) {
    if (inactive) {
        inactiveForms.add(form);
    } else {
        inactiveForms.delete(form);
    }
}

function isFormInactive(form) {
    return inactiveForms.has(form);
}

function setFormCoverToken(form, token) {
    if (token) {
        coverTokens.set(form, token);
    } else {
        coverTokens.delete(form);
    }
}

//
//  The suspend token |form|'s cover() holds, or null. A token that is no
//  longer held -- dropped with every other suspend at a menu change
//  (View.dropBackgroundDrawSuspends()), or resumed -- does not count: the
//  form is no longer covered (it stays inactive), and a later cover()
//  takes a new one.
//
function getFormCoverToken(form) {
    const token = coverTokens.get(form);
    if (!token) {
        return null;
    }
    if (token.ended) {
        coverTokens.delete(form);
        return null;
    }
    return token;
}

function markFormDestroyed(form) {
    destroyedForms.add(form);
}

function isFormDestroyed(form) {
    return destroyedForms.has(form);
}

//  True while |form| takes no keys on purpose: deactivated, or covered
function isFormPaused(form) {
    return !!form && (inactiveForms.has(form) || null !== getFormCoverToken(form));
}

module.exports = {
    setViewForm,
    getViewForm,
    isFormOfMenu,
    setFormInactive,
    isFormInactive,
    setFormCoverToken,
    getFormCoverToken,
    markFormDestroyed,
    isFormDestroyed,
    isFormPaused,
};
