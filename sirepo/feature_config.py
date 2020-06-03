# -*- coding: utf-8 -*-
u"""List of features available

:copyright: Copyright (c) 2016 RadiaSoft LLC.  All Rights Reserved.
:license: http://www.apache.org/licenses/LICENSE-2.0.html
"""
from __future__ import absolute_import, division, print_function
# defer all imports so *_CODES is available to testing functions


#: Codes on beta and prod
NON_ALPHA_CODES = frozenset((
    'elegant',
    'jspec',
    'opal',
    'shadow',
    'srw',
    'synergia',
    'warppba',
    'warpvnd',
    'webcon',
    'zgoubi',
))

#: Codes on dev and alpha
ALPHA_CODES = frozenset((
    'flash',
    'radia',
    'madx',
    'myapp',
    'rcscon',
    'rs4pi',
))

#: All possible codes
ALL_CODES = NON_ALPHA_CODES.union(ALPHA_CODES)


#: codes which we include in dev for testing
_DEV_PROPRIETARY_CODES = ('flash',)


#: Configuration
_cfg = None


def cfg():
    """global configuration

    Returns:
        dict: configurated features
    """
    global _cfg
    return _cfg or _init()


def for_sim_type(sim_type):
    """Get cfg for simulation type

    Args:
        sim_type (str): srw, warppba, etc.

    Returns:
        dict: application specific config
    """
    import pykern.pkcollections

    c = cfg()
    if sim_type not in c:
        return pykern.pkcollections.PKDict()
    return pykern.pkcollections.PKDict(
        pykern.pkcollections.map_items(c[sim_type]),
    )


def _init():
    from pykern import pkconfig
    global _cfg

    _cfg = pkconfig.init(
        api_modules=((), set, 'optional api modules, e.g. status'),
        jspec=dict(
            derbenevskrinsky_force_formula=(pkconfig.channel_in_internal_test(), bool, 'Include Derbenev-Skrinsky force forumla'),
        ),
        proprietary_sim_types=(
            _DEV_PROPRIETARY_CODES if pkconfig.channel_in('dev') else set(),
            set,
            'codes that require authorization',
        ),
        #TODO(robnagler) make sim_type config
        rs4pi_dose_calc=(False, bool, 'run the real dose calculator'),
        sim_types=(set(), set, 'simulation types (codes) to be imported'),
        srw=dict(
            mask_in_toolbar=(pkconfig.channel_in_internal_test(), bool, 'Show the mask element in toolbar'),
            beamline3d=(pkconfig.channel_in_internal_test(), bool, 'Show 3D beamline plot'),
        ),
        warpvnd=dict(
            allow_3d_mode=(True, bool, 'Include 3D features in the Warp VND UI'),
            display_test_boxes=(pkconfig.channel_in_internal_test(), bool, 'Display test boxes to visualize 3D -> 2D projections'),
        ),
    )
    a = ALL_CODES if pkconfig.channel_in_internal_test() else NON_ALPHA_CODES
    s = set(_cfg.sim_types) if _cfg.sim_types else set(a)
    s.update(_cfg.proprietary_sim_types)
    # jspec imports elegant, but elegant won't work if it is not a valid
    # sim_type so need to include here. Need a better model of
    # dependencies between codes.
    if 'jspec' in s and 'elegant' not in s:
        s.add('elegant')
    x = s.difference(a)
    assert not x, \
        'sim_type(s) invalid={} expected={}'.format(x, a)
    _cfg.sim_types = frozenset(s)
    return _cfg
